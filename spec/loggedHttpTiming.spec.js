/**
 * loggedHttp per-call timing log (ported from ts_lambda PR #238, 2026-10-07).
 *
 * Every attempt emits one text-prefixed line:
 *   loggedHttp timing {"fn":…,"method":…,"target":…,"attempt":"1/3","status":200,"ms":412}
 * ESM has no require.cache to swap axios, so these specs drive loggedHttp through
 * axios's own `adapter` hook (a per-request transport override) — no network, no
 * module mocking. Failure cases pass `maxTries: 1` (this copy has no test-env retry
 * suppression, and the default interval is 30 s).
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
    const all = logSpy.calls.allArgs().flat().join(' ');
    expect(all).not.toContain('SUPERSECRET');
    expect(all).not.toContain('apipass');
    expect(parseLine(timingLines(logSpy)[0]).target).toBe('https://www.theraspecs.api-us1.com/admin/api.php');
  });

  it('redacts the PATH for capability-URL hosts (Slack response_url, Zapier hooks, Botpress webhook)', () => {
    expect(_timing.timingTarget('https://hooks.slack.com/actions/T1/B2/SecretPathToken')).toBe('https://hooks.slack.com/<redacted>');
    expect(_timing.timingTarget('https://hooks.zapier.com/hooks/catch/1/abc/')).toBe('https://hooks.zapier.com/<redacted>');
    expect(_timing.timingTarget('https://webhook.botpress.cloud/secret-id')).toBe('https://webhook.botpress.cloud/<redacted>');
    expect(_timing.timingTarget('not a url')).toBe('<unparseable-url>');
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

  it('logs a failed attempt to console.warn with `error` (redacted) + status; the ORIGINAL error rejects; slackChannel null disarms Slack', async () => {
    const err = new Error('upstream rejected https://x.test/api.php?api_key=SUPERSECRET');
    err.response = { status: 503, data: {} };
    const adapter = async () => { throw err; };
    await expectAsync(loggedHttp({ method: 'get', url: 'https://x.test/api.php?token=HIDDEN', adapter }, { functionName: 'spec', maxTries: 1, slackChannel: null })).toBeRejectedWith(err);
    const warnLines = timingLines(warnSpy);
    expect(warnLines.length).toBe(1);
    const rec = parseLine(warnLines[0]);
    expect(rec.status).toBe(503);
    expect(rec.attempt).toBe('1/1');
    expect(rec.target).toBe('https://x.test/api.php');
    expect(warnLines[0]).not.toContain('HIDDEN');
    expect(warnLines[0]).not.toContain('SUPERSECRET');
  });

  it('scrubs capability URLs, userinfo and Bearer tokens EMBEDDED in free-text error messages', () => {
    const out = _timing.scrubErrorText('rejected https://hooks.slack.com/actions/T1/B2/SecretPathToken and https://u:apipass@api.x.test/v1/x?y=1 with Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toContain('SecretPathToken');
    expect(out).not.toContain('apipass');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(out).toContain('https://hooks.slack.com '); // scheme + host only
    expect(out).toContain('https://api.x.test ');
    expect(out).not.toContain('/v1/x');
    expect(out).toContain('Authorization: [REDACTED]'); // colon-named credentials mask to end of line
    // and through the live path (whichever redactor branch this copy runs):
    expect(_timing.safeErrorText('rejected https://hooks.slack.com/actions/T1/B2/SecretPathToken')).not.toContain('SecretPathToken');
  });

  it('a `)` inside URL userinfo cannot split the match and leak a password fragment; short credentials (Basic YTpi, short Bearer) are masked too', () => {
    const out = _timing.scrubErrorText('rejected https://reader:prefix)SecretSuffix@api.example.test/v1 (Authorization: Basic YTpi) and Bearer ab12');
    expect(out).not.toContain('SecretSuffix');
    expect(out).not.toContain('prefix)');
    expect(out).not.toContain('YTpi');
    expect(out).not.toContain('ab12');
    expect(out).toContain('https://api.example.test (Authorization: [REDACTED]');
  });

  it('round 5: aligned stems, multi-word labels, multi-value headers and "Authorization=Bearer …" are all masked', () => {
    for (const msg of ['API key: SUPERSECRET1', 'Cookie: SID=first; LSID=SUPERSECRET2', 'Authorization: Digest username="u", response="SUPERSECRET3"', 'private_key: SUPERSECRET5 pwd: SUPERSECRET6', 'passphrase: SUPERSECRET7', 'access-key: SUPERSECRET8', 'jwt: SUPERSECRET9', 'X-Access-Key: SUPERSECRET10']) {
      expect(_timing.scrubErrorText(msg)).withContext(msg).not.toMatch(/SUPERSECRET\d+/);
    }
    // The pair form goes through the live safeErrorText path (auth scrub BEFORE the redactor):
    expect(_timing.safeErrorText({ message: 'Authorization=Bearer SUPERSECRET4' })).not.toContain('SUPERSECRET4');
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

  it('logs a non-2xx resolved response as "HTTP <status>" only — never the body', async () => {
    await expectAsync(loggedHttp({ method: 'get', url: 'https://example.test/missing', adapter: okAdapter(404, { detail: 'api_key=SUPERSECRET' }) }, { functionName: 'spec', maxTries: 1, slackChannel: null })).toBeRejected();
    const line = timingLines(warnSpy)[0];
    expect(parseLine(line).error).toBe('HTTP 404');
    expect(line).not.toContain('SUPERSECRET');
  });

  it('uses the network error code when there is no HTTP status', async () => {
    const err = new Error('timeout of 30000ms exceeded'); err.code = 'ECONNABORTED';
    await expectAsync(loggedHttp({ method: 'get', url: 'https://example.test/slow', adapter: async () => { throw err; } }, { functionName: 'spec', maxTries: 1, slackChannel: null })).toBeRejected();
    const rec = parseLine(timingLines(warnSpy)[0]);
    expect(rec.status).toBeNull();
    expect(rec.error).toBe('ECONNABORTED');
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

  it('safeErrorText: redactor present → scrubbed; redactor absent → fail closed on provenance (only err.code / HTTP n, never message text)', async () => {
    // This copy's reportExceptions export set decides which branch is live (see the
    // namespace-import note in utils/loggedHttp.js). Either way no secret may pass.
    const ns = await import('../utils/reportExceptions.js');
    const hasRedactor = typeof ns.redactUrl === 'function';
    expect(_timing.safeErrorText({ message: 'upstream said api_key=SUPERSECRET' })).not.toContain('SUPERSECRET');
    expect(_timing.safeErrorText({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(_timing.safeErrorText({ code: 'HTTP 503' })).toBe('HTTP 503');
    const codeLooking = _timing.safeErrorText({ message: 'SUPERSECRETTOKEN_ABC123' });
    if (hasRedactor) expect(codeLooking).toBe('SUPERSECRETTOKEN_ABC123'); // free text passes the redactor branch (no known pattern)
    else expect(codeLooking).toBe('<error text withheld: redactor unavailable>'); // fail closed: shape is not provenance
  });

  it('compact JSON with two URLs in one token, and colon-delimited credentials, are scrubbed', () => {
    const out = _timing.scrubErrorText('rejected {"url":"https://api.x.test/v1","next":"https://hooks.slack.com/actions/T/B/SecretPathToken"} X-API-Key: SUPERSECRET1, api_key: SUPERSECRET2 Authorization: Bearer SUPERSECRET4');
    for (const s of ['SecretPathToken', 'SUPERSECRET1', 'SUPERSECRET2', 'SUPERSECRET4']) expect(out).not.toContain(s);
    expect(out.startsWith('rejected {"url":"https://api.x.test X-API-Key: [REDACTED]')).toBe(true); // token → first URL's scheme+host only
    expect(out).not.toContain('hooks.slack.com/actions');
    expect(out).toContain('X-API-Key: [REDACTED]');
    expect(out).not.toContain('SUPERSECRET');
  });

  it('a rejected object whose code/message/response getters THROW does not alter the call (every attempt still runs)', async () => {
    // Through the real axios pipeline the adapter rejection is normalised by axios
    // itself (it reads `reason.response`), so the identity of the rejection is axios's
    // business here; what loggedHttp owes is that its telemetry never skips a retry or
    // swallows the failure. logTiming itself is pinned directly below.
    const evil = {};
    Object.defineProperty(evil, 'code', { get() { throw new Error('getter boom'); } });
    Object.defineProperty(evil, 'message', { get() { throw new Error('getter boom'); } });
    Object.defineProperty(evil, 'response', { get() { throw new Error('getter boom'); } });
    let calls = 0;
    const adapter = async () => { calls += 1; throw evil; };
    await expectAsync(loggedHttp({ method: 'get', url: 'https://example.test/x', adapter }, { functionName: 'spec', maxTries: 2, retryInterval: 0, slackChannel: null })).toBeRejected();
    expect(calls).toBe(2);
    // Direct: logTiming with the hostile object neither throws nor drops its line — details marked unreadable.
    warnSpy.calls.reset();
    expect(() => _timing.logTiming({ functionName: 'spec', method: 'get', url: 'https://example.test/x', attempt: 1, maxTries: 1, durationMs: 1, err: evil })).not.toThrow();
    expect(timingLines(warnSpy).length).toBe(1);
    expect(parseLine(timingLines(warnSpy)[0]).error).toBe('<error details unreadable>');
  });

  it('URL path suffixes after `;` or `,` on a capability host, quoted JSON keys with unquoted values, and escaped quotes inside quoted values are all masked', () => {
    const out = _timing.scrubErrorText('rejected https://hooks.slack.com/services/T,B/SecretSuffix1 and https://hooks.slack.com/actions/T/B/Prefix;SecretSuffix2 {"api_key":123456} password: "prefix\\"SecretSuffix3" done');
    for (const s of ['SecretSuffix1', 'SecretSuffix2', '123456', 'SecretSuffix3']) expect(out).not.toContain(s);
    expect(out).toContain('https://hooks.slack.com and https://hooks.slack.com ');
    expect(out).toContain('api_key: [REDACTED]');
    expect(out).not.toContain('done'); // masked to end of line
  });
});
