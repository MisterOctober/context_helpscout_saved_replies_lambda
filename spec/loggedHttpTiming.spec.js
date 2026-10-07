/**
 * loggedHttp per-call timing log (ported from ts_lambda PR #238, 2026-10-07).
 *
 * Every attempt emits one text-prefixed line:
 *   loggedHttp timing {"fn":…,"method":…,"target":…,"attempt":"1/3","status":200,"ms":412[,"error":"ECONNRESET"]}
 * The `error` field is a PROVENANCE-KNOWN CODE ONLY (err.code / `HTTP <status>` / `request failed`);
 * message text is never logged (design ruling after six review rounds).
 *
 * ESM has no require.cache to swap axios, so these specs drive loggedHttp through axios's own
 * `adapter` hook (a per-request transport override) — no network, no module mocking. Failure
 * cases pass `maxTries: 1` (this copy has no test-env retry suppression; default interval 30 s).
 */
import loggedHttp, { _timing } from '../utils/loggedHttp.js';

const okAdapter = (status = 200, data = {}) => async (config) => ({ status, statusText: 'OK', headers: {}, data, config });
const parseLine = (line) => JSON.parse(line.slice(line.indexOf('{')));

describe('loggedHttp per-call timing log', () => {
  let logSpy;
  let warnSpy;
  let origSlowMs;

  beforeEach(() => {
    origSlowMs = process.env.LOGGED_HTTP_SLOW_MS;
    delete process.env.LOGGED_HTTP_SLOW_MS;
    logSpy = spyOn(console, 'log').and.stub();
    warnSpy = spyOn(console, 'warn').and.stub();
  });

  afterEach(() => {
    if (origSlowMs === undefined) delete process.env.LOGGED_HTTP_SLOW_MS; else process.env.LOGGED_HTTP_SLOW_MS = origSlowMs;
  });

  const timingLines = (spy) => spy.calls.allArgs().map(a => a[0]).filter(s => typeof s === 'string' && s.startsWith('loggedHttp timing'));
  const allOutput = () => logSpy.calls.allArgs().flat().join(' ') + ' ' + warnSpy.calls.allArgs().flat().join(' ');

  it('logs exactly one "loggedHttp timing" line for a successful call and still returns response.data', async () => {
    const data = await loggedHttp({ method: 'get', url: 'https://api.notion.com/v1/databases/abc/query?x=1', adapter: okAdapter(200, { results: [] }) }, { functionName: 'specFn' });
    expect(data).toEqual({ results: [] });
    const lines = timingLines(logSpy);
    expect(lines.length).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
    const rec = parseLine(lines[0]);
    expect(rec.fn).toBe('specFn');
    expect(rec.method).toBe('GET');
    expect(rec.target).toBe('https://api.notion.com/v1/databases/abc/query'); // query DROPPED
    expect(rec.attempt).toBe('1/3');
    expect(rec.status).toBe(200);
    expect(typeof rec.ms).toBe('number');
  });

  it('never logs the query string (the ActiveCampaign api_key leak class) and drops URL userinfo', async () => {
    await loggedHttp({ method: 'get', url: 'https://u:apipass@www.theraspecs.api-us1.com/admin/api.php?api_key=SUPERSECRET', adapter: okAdapter() }, { functionName: 'ac' });
    expect(allOutput()).not.toContain('SUPERSECRET');
    expect(allOutput()).not.toContain('apipass');
    expect(parseLine(timingLines(logSpy)[0]).target).toBe('https://www.theraspecs.api-us1.com/admin/api.php');
  });

  it('redacts the PATH for capability-URL hosts (Slack response_url, Zapier hooks, Botpress webhook)', () => {
    expect(_timing.timingTarget('https://hooks.slack.com/actions/T1/B2/SecretPathToken')).toBe('https://hooks.slack.com/<redacted>');
    expect(_timing.timingTarget('https://hooks.zapier.com/hooks/catch/1/abc/')).toBe('https://hooks.zapier.com/<redacted>');
    expect(_timing.timingTarget('https://webhook.botpress.cloud/secret-id')).toBe('https://webhook.botpress.cloud/<redacted>');
    expect(_timing.timingTarget('not a url')).toBe('<unparseable-url>');
    expect(_timing.timingTarget('data:text/plain,API_KEY_SUPERSECRET')).toBe('<non-http-url>'); // opaque schemes never render their payload
    expect(_timing.timingTarget('mailto:someone@example.test?subject=SUPERSECRET')).toBe('<non-http-url>');
  });

  it('a FALSY rejection reason is still a failed attempt: warn line with error "request failed"', () => {
    // Through real axios a falsy adapter rejection is normalised, so pin logTiming directly.
    for (const reason of [undefined, null, 0, '', false]) {
      warnSpy.calls.reset(); logSpy.calls.reset();
      _timing.logTiming({ functionName: 'spec', method: 'get', url: 'https://example.test/x', attempt: 1, maxTries: 1, durationMs: 5, err: reason, failed: true });
      expect(timingLines(logSpy).length).withContext(String(reason)).toBe(0);
      expect(timingLines(warnSpy).length).withContext(String(reason)).toBe(1);
      expect(parseLine(timingLines(warnSpy)[0]).error).withContext(String(reason)).toBe('request failed');
    }
  });

  it('marks a call at/over the slow threshold "SLOW" and routes it to console.warn (default 2000 ms)', async () => {
    let tick = 0;
    spyOn(Date, 'now').and.callFake(() => { tick += 1; return tick === 1 ? 1000000 : 1002500; });
    await loggedHttp({ method: 'get', url: 'https://example.test/x', adapter: okAdapter() }, { functionName: 'spec' });
    expect(timingLines(logSpy).length).toBe(0);
    const warnLines = timingLines(warnSpy);
    expect(warnLines.length).toBe(1);
    expect(warnLines[0].startsWith('loggedHttp timing SLOW ')).toBe(true);
    expect(parseLine(warnLines[0]).ms).toBe(2500);
  });

  it('honors LOGGED_HTTP_SLOW_MS as the slow threshold', async () => {
    process.env.LOGGED_HTTP_SLOW_MS = '1';
    let tick = 0;
    spyOn(Date, 'now').and.callFake(() => { tick += 1; return tick === 1 ? 5000 : 5003; });
    await loggedHttp({ method: 'get', url: 'https://example.test/x', adapter: okAdapter() }, { functionName: 'spec' });
    expect(parseLine(timingLines(warnSpy)[0]).ms).toBe(3);
  });

  it('LOGGED_HTTP_SLOW_MS=0 is a VALID threshold (every call is SLOW); blank, non-numeric and negative values fall back to 2000', async () => {
    expect(_timing.slowThresholdMs()).toBe(2000);
    process.env.LOGGED_HTTP_SLOW_MS = '0';
    expect(_timing.slowThresholdMs()).toBe(0);
    await loggedHttp({ method: 'get', url: 'https://example.test/x', adapter: okAdapter() }, { functionName: 'spec' });
    expect(timingLines(warnSpy).length).toBe(1);
    expect(timingLines(warnSpy)[0].startsWith('loggedHttp timing SLOW ')).toBe(true);
    for (const bad of ['', '  ', 'abc', '-5', 'NaN']) { process.env.LOGGED_HTTP_SLOW_MS = bad; expect(_timing.slowThresholdMs()).toBe(2000); }
  });

  it('logs a failed attempt to console.warn with err.code + status; the ORIGINAL error rejects; message text is NEVER logged', async () => {
    const err = new Error('upstream rejected https://x.test/api.php?api_key=SUPERSECRET');
    err.code = 'ERR_BAD_RESPONSE';
    err.response = { status: 503, data: {} };
    const adapter = async () => { throw err; };
    await expectAsync(loggedHttp({ method: 'get', url: 'https://x.test/api.php?token=HIDDEN', adapter }, { functionName: 'spec', maxTries: 1, slackChannel: null })).toBeRejectedWith(err);
    const warnLines = timingLines(warnSpy);
    expect(warnLines.length).toBe(1);
    const rec = parseLine(warnLines[0]);
    expect(rec.status).toBe(503);
    expect(rec.error).toBe('ERR_BAD_RESPONSE');
    expect(rec.attempt).toBe('1/1');
    expect(rec.target).toBe('https://x.test/api.php');
    expect(warnLines[0]).not.toContain('HIDDEN');
    expect(warnLines[0]).not.toContain('SUPERSECRET');
  });

  it('logs a non-2xx resolved response as "HTTP <status>" only — never the body', async () => {
    await expectAsync(loggedHttp({ method: 'get', url: 'https://example.test/missing', adapter: okAdapter(404, { detail: 'api_key=SUPERSECRET' }) }, { functionName: 'spec', maxTries: 1, slackChannel: null })).toBeRejected();
    const line = timingLines(warnSpy)[0];
    expect(parseLine(line).error).toBe('HTTP 404');
    expect(line).not.toContain('SUPERSECRET');
  });

  it('uses the network error code when there is no HTTP status; "request failed" when there is neither', async () => {
    const err = new Error('timeout of 30000ms exceeded'); err.code = 'ECONNABORTED';
    await expectAsync(loggedHttp({ method: 'get', url: 'https://example.test/slow', adapter: async () => { throw err; } }, { functionName: 'spec', maxTries: 1, slackChannel: null })).toBeRejected();
    const rec = parseLine(timingLines(warnSpy)[0]);
    expect(rec.status).toBeNull();
    expect(rec.error).toBe('ECONNABORTED');
    warnSpy.calls.reset();
    await expectAsync(loggedHttp({ method: 'get', url: 'https://example.test/slow', adapter: async () => { throw new Error('API key SUPERSECRET'); } }, { functionName: 'spec', maxTries: 1, slackChannel: null })).toBeRejected();
    expect(parseLine(timingLines(warnSpy)[0]).error).toBe('request failed');
    expect(allOutput()).not.toContain('SUPERSECRET');
  });

  it('errorCodeText: code wins, then HTTP <status>, then "request failed"; message text is never consulted', () => {
    expect(_timing.errorCodeText({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(_timing.errorCodeText({ code: 'ECONNRESET', status: 503 })).toBe('ECONNRESET');
    expect(_timing.errorCodeText({ status: 503 })).toBe('HTTP 503');
    expect(_timing.errorCodeText({})).toBe('request failed');
    expect(_timing.errorCodeText({ code: 'not a code' })).toBe('request failed');
  });

  it('emits ONE line PER ATTEMPT across retries: warn "1/2" then success "2/2"', async () => {
    let calls = 0;
    const adapter = async (config) => {
      calls += 1;
      if (calls === 1) { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; }
      return { status: 201, statusText: 'Created', headers: {}, data: { ok: true }, config };
    };
    const data = await loggedHttp({ method: 'get', url: 'https://example.test/things', adapter }, { functionName: 'spec', maxTries: 2, retryInterval: 0, slackChannel: null });
    expect(data).toEqual({ ok: true });
    const warnLines = timingLines(warnSpy).map(parseLine);
    const okLines = timingLines(logSpy).map(parseLine);
    expect(warnLines.length).toBe(1);
    expect(warnLines[0].attempt).toBe('1/2');
    expect(warnLines[0].error).toBe('ECONNRESET');
    expect(okLines.length).toBe(1);
    expect(okLines[0].attempt).toBe('2/2');
  });

  it('NEVER alters the call: a throwing console still returns the data and still rejects with the original error', async () => {
    logSpy.and.throwError('console exploded');
    warnSpy.and.throwError('console exploded');
    const data = await loggedHttp({ method: 'get', url: 'https://example.test/x', adapter: okAdapter(200, { fine: true }) }, { functionName: 'spec' });
    expect(data).toEqual({ fine: true });
    const netErr = new Error('boom'); netErr.code = 'ECONNRESET';
    await expectAsync(loggedHttp({ method: 'get', url: 'https://example.test/x', adapter: async () => { throw netErr; } }, { functionName: 'spec', maxTries: 1, slackChannel: null })).toBeRejectedWith(netErr);
  });

  it('a rejected object whose code/message/response getters THROW does not alter the call (every attempt still runs) and logTiming still emits its line', async () => {
    // Through the real axios pipeline the adapter rejection is normalised by axios itself
    // (it reads `reason.response`), so the rejection identity is axios's business here; what
    // loggedHttp owes is that telemetry never skips a retry or swallows the failure.
    const evil = {};
    Object.defineProperty(evil, 'code', { get() { throw new Error('getter boom'); } });
    Object.defineProperty(evil, 'message', { get() { throw new Error('getter boom'); } });
    Object.defineProperty(evil, 'response', { get() { throw new Error('getter boom'); } });
    let calls = 0;
    const adapter = async () => { calls += 1; throw evil; };
    await expectAsync(loggedHttp({ method: 'get', url: 'https://example.test/x', adapter }, { functionName: 'spec', maxTries: 2, retryInterval: 0, slackChannel: null })).toBeRejected();
    expect(calls).toBe(2);
    warnSpy.calls.reset();
    expect(() => _timing.logTiming({ functionName: 'spec', method: 'get', url: 'https://example.test/x', attempt: 1, maxTries: 1, durationMs: 1, err: evil, failed: true })).not.toThrow();
    expect(timingLines(warnSpy).length).toBe(1);
    expect(parseLine(timingLines(warnSpy)[0]).error).toBe('<error details unreadable>');
  });
});
