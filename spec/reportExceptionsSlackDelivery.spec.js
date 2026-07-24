/**
 * Tests for utils/reportExceptions.js — Slack delivery mechanics.
 *
 * Context (bug fixed 2026-07-23, authorized @MisterOctober): the original code
 * POSTed JSON to `files.getUploadURLExternal`, which only accepts form-encoded
 * arguments — Slack replied `{ ok:false, error:'invalid_arguments' }`, the
 * not-ok response was silently swallowed, and the fallback (`files.upload`)
 * had been retired by Slack (`method_deprecated`). Net effect: NO exception
 * ever reached the Slack error channel. These specs pin the fixed contract:
 *   1. getUploadURLExternal receives a form-encoded string body (never JSON);
 *   2. a not-ok response is logged and degrades to chat.postMessage
 *      (files.upload is never called);
 *   3. oversized payloads are truncated in the fallback message.
 *
 * Isolation: axios.post is spied per-spec (the axios default export is a
 * shared mutable object, so spyOn works under ESM too); token env is
 * saved/restored around each spec.
 */
import axios from 'axios';
import reportExceptions, { reportExceptionToSlack } from '../utils/reportExceptions.js';

describe('reportExceptionToSlack delivery mechanics (2026-07-23 fix)', () => {
  let postSpy;
  let origToken;

  beforeEach(() => {
    origToken = process.env.THERABOT2_TOKEN;
    process.env.THERABOT2_TOKEN = 'xoxb-spec-token';
    postSpy = spyOn(axios, 'post');
  });

  afterEach(() => {
    if (origToken === undefined) delete process.env.THERABOT2_TOKEN;
    else process.env.THERABOT2_TOKEN = origToken;
  });

  it('sends form-encoded (NOT JSON) arguments to files.getUploadURLExternal and completes into the channel', async () => {
    postSpy.and.callFake(async (url) => {
      if (String(url).includes('getUploadURLExternal')) {
        return { data: { ok: true, upload_url: 'https://upload.example', file_id: 'F123' } };
      }
      return { data: { ok: true } };
    });

    await reportExceptionToSlack({ error: new Error('boom'), channel: 'C123', functionName: 'specFn' });

    const getUrlCall = postSpy.calls.all().find((c) => String(c.args[0]).includes('getUploadURLExternal'));
    expect(getUrlCall).toBeDefined();
    // Slack rejects application/json on this method — the body must be a
    // URL-encoded string with a form content-type.
    expect(typeof getUrlCall.args[1]).toBe('string');
    expect(getUrlCall.args[1]).toContain('filename=error_payload.json');
    expect(getUrlCall.args[1]).toMatch(/length=\d+/);
    expect(getUrlCall.args[2].headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const completeCall = postSpy.calls.all().find((c) => String(c.args[0]).includes('completeUploadExternal'));
    expect(completeCall).toBeDefined();
    expect(completeCall.args[1].channel_id).toBe('C123');
  });

  it('logs a not-ok getUploadURLExternal response and degrades to chat.postMessage (never files.upload)', async () => {
    const warnSpy = spyOn(console, 'warn');
    postSpy.and.callFake(async (url) => {
      if (String(url).includes('getUploadURLExternal')) {
        return { data: { ok: false, error: 'invalid_arguments' } };
      }
      if (String(url).includes('chat.postMessage')) {
        return { data: { ok: true, ts: '1.2' } };
      }
      throw new Error(`unexpected Slack call: ${url}`);
    });

    await reportExceptionToSlack({ error: new Error('boom'), channel: 'C123', functionName: 'specFn' });

    // The silent-swallow is gone: the not-ok reason is logged.
    expect(warnSpy).toHaveBeenCalledWith(
      'files.getUploadURLExternal returned not-ok:',
      jasmine.objectContaining({ error: 'invalid_arguments' })
    );

    const postMsgCall = postSpy.calls.all().find((c) => String(c.args[0]).includes('chat.postMessage'));
    expect(postMsgCall).toBeDefined();
    expect(postMsgCall.args[1].channel).toBe('C123');
    expect(postMsgCall.args[1].text).toContain('specFn');
    expect(postMsgCall.args[1].text).toContain('boom');

    // The retired method must never be called again.
    expect(postSpy.calls.all().some((c) => String(c.args[0]).includes('files.upload'))).toBe(false);
  });

  it('truncates an oversized payload in the chat.postMessage fallback', async () => {
    postSpy.and.callFake(async (url) => {
      if (String(url).includes('getUploadURLExternal')) {
        return { data: { ok: false, error: 'invalid_arguments' } };
      }
      return { data: { ok: true } };
    });

    const bigError = new Error('huge');
    bigError.stack = 'x'.repeat(20000);
    await reportExceptionToSlack({ error: bigError, channel: 'C123', functionName: 'specFn' });

    const postMsgCall = postSpy.calls.all().find((c) => String(c.args[0]).includes('chat.postMessage'));
    expect(postMsgCall).toBeDefined();
    expect(postMsgCall.args[1].text).toContain('[truncated — full payload in CloudWatch]');
    // 8000-char payload cap + comment/fence overhead stays well under Slack limits.
    expect(postMsgCall.args[1].text.length).toBeLessThan(9500);
  });

  it('carries stage and redacted extra context into the Slack report (2026-07-24 enrichment)', async () => {
    postSpy.and.callFake(async (url) => {
      if (String(url).includes('getUploadURLExternal')) {
        return { data: { ok: false, error: 'invalid_arguments' } };
      }
      return { data: { ok: true } };
    });

    await reportExceptionToSlack({
      error: new Error('boom'),
      channel: 'C123',
      functionName: 'specFn',
      stage: 'resolve_handler',
      extraContext: { alertUrl: 'http://pg/alerts?name=eq.x', api_key: 'sekrit-value' }
    });

    const postMsgCall = postSpy.calls.all().find((c) => String(c.args[0]).includes('chat.postMessage'));
    expect(postMsgCall).toBeDefined();
    // Stage is surfaced in the comment line, so same-error reports from
    // different layers are distinguishable at a glance.
    expect(postMsgCall.args[1].text).toContain('*Stage*: `resolve_handler`');
    // Extra context reaches the payload…
    expect(postMsgCall.args[1].text).toContain('http://pg/alerts?name=eq.x');
    // …with the redaction pass applied (sensitive keys masked).
    expect(postMsgCall.args[1].text).toContain('[REDACTED]');
    expect(postMsgCall.args[1].text).not.toContain('sekrit-value');
  });

  it('reportExceptions forwards stage + remaining context keys, hoisting functionName/axiosConfig/channel', async () => {
    postSpy.and.callFake(async (url) => {
      if (String(url).includes('getUploadURLExternal')) {
        return { data: { ok: false, error: 'invalid_arguments' } };
      }
      return { data: { ok: true } };
    });

    await reportExceptions(new Error('boom'), {
      functionName: 'specFn',
      stage: 'top_level',
      channel: 'C123',
      alertName: 'foo_alert'
    });

    const postMsgCall = postSpy.calls.all().find((c) => String(c.args[0]).includes('chat.postMessage'));
    expect(postMsgCall).toBeDefined();
    expect(postMsgCall.args[1].channel).toBe('C123');
    expect(postMsgCall.args[1].text).toContain('*Stage*: `top_level`');
    // The leftover context key rides along as extraContext…
    expect(postMsgCall.args[1].text).toContain('foo_alert');
    // …but the hoisted keys are not duplicated into it.
    expect(postMsgCall.args[1].text).not.toContain('"functionName"');
  });
});
