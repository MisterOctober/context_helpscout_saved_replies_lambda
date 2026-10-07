import axios from 'axios';
import * as reportExceptionsModule from './reportExceptions.js';
// Namespace import: one sibling (context_helpscout_saved_replies_lambda) has no
// redactUrl export, and a missing NAMED import is a link-time SyntaxError in ESM.
// Reading it off the namespace yields undefined there → safeErrorText fails closed.
const { reportExceptionToSlack, redactUrl } = reportExceptionsModule;

// ── Per-call timing log (ported from ts_lambda PR #238, owner-directed 2026-10-07) ──
// Until now loggedHttp logged NOTHING on a successful call, so a slow external
// dependency could not be attributed from CloudWatch. Every attempt now emits ONE
// text-prefixed line:
//   loggedHttp timing {"fn":"…","method":"GET","target":"https://host/path","attempt":"1/3","status":200,"ms":412}
// `SLOW` is appended (and the line goes to console.warn) when ms >= the slow
// threshold (LOGGED_HTTP_SLOW_MS, default 2000); failed attempts also go to warn
// with an `error` field. Text prefix on purpose: these functions log in Text
// format, so CloudWatch metric filters must be substring patterns and Insights can
// use `filter @message like /loggedHttp timing/`.
// Secret-safe by construction: method, host and PATH only — never the query string
// (ActiveCampaign carries `api_key` there) — and the path is `/<redacted>` for
// capability-URL hosts (hooks.slack.com response_urls, hooks.zapier.com,
// webhook.botpress.cloud), where the path IS the credential. Error text passes
// through reportExceptions.redactUrl when available and FAILS CLOSED (bare codes
// only) when it is not.
// NEVER-THROW CONTRACT: logTiming runs inside the retry loop's try/catch; a throw
// there would turn a 2xx into a retried (duplicated) write or replace the real
// network error. Telemetry must not alter the call it observes.
const DEFAULT_SLOW_MS = 2000;
/**
 * Secret-safe rendering of a request URL for the timing line.
 * @param {string} url - e.g. 'https://x.api-us1.com/admin/api.php?api_key=SECRET&api_action=contact_list'
 * @returns {string} 'https://x.api-us1.com/admin/api.php' (query dropped);
 *   'https://hooks.slack.com/<redacted>' for capability-URL hosts; '<unparseable-url>' otherwise
 */
function timingTarget(url) {
  try {
    const parsed = new URL(String(url));
    // hooks.slack.com, hooks.zapier.com, webhook.botpress.cloud, …: the path is the credential.
    const isCapabilityHost = /(^|\.)(web)?hooks?\./i.test(parsed.host);
    return `${parsed.protocol}//${parsed.host}${isCapabilityHost ? '/<redacted>' : parsed.pathname}`;
  } catch (e) {
    return '<unparseable-url>';
  }
}

/**
 * A bare error code as produced by Node/axios (`ECONNRESET`, `EAI_AGAIN`,
 * `ERR_BAD_RESPONSE`) or by us (`HTTP 503`). Used ONLY to validate a value whose
 * provenance is already known to be a code (err.code / our own `HTTP <status>`) —
 * never to classify free text (an uppercase secret would pass a shape test).
 */
const BARE_ERROR_CODE_RE = /^(?:[A-Z][A-Z0-9_]{2,39}|HTTP \d{3})$/;

/**
 * Free-text scrubbing (Copilot on the port, 2026-10-07, four rounds).
 * - A URL embedded in free text is reduced to SCHEME + HOST only. Nothing after the
 *   host is ever emitted: paths can be capability credentials, queries can carry keys,
 *   userinfo can carry passwords, and compact JSON can glue a second URL onto the
 *   first. Every delimiter heuristic tried in review leaked a suffix (`;` and `,` are
 *   legal path characters; a parseable head proves nothing about where the URL ends).
 *   The request's own path is already in the structured `target` field, so host-only
 *   costs no diagnostic signal here. Tokens run to the next whitespace; an unparseable
 *   token is withheld whole.
 * - Auth-scheme credentials have NO minimum length (`Basic YTpi` is valid).
 * - Colon-delimited credentials (`X-API-Key: …`, `"api_key":123456`, `password: "a\"b"`)
 *   are masked: optional quotes around the name, quoted values consume escaped
 *   characters, unquoted values run to whitespace / `,` `;` `}` `]`. Over-redaction
 *   of innocent text ("token expired") is accepted.
 */
const URL_IN_TEXT_RE = /https?:\/\/\S+/gi;
/**
 * Sensitive-name stems — the SAME list reportExceptions' SENSITIVE_KEY_RE uses, so the
 * two redaction passes can never disagree about what is a credential name (Copilot on
 * the port, round 5). Compound stems accept space as well as - and _ ("API key").
 */
const SENSITIVE_STEMS = 'auth|bearer|cookie|token|secret|credential|password|passwd|pwd|passphrase|api[-_ ]?key|apikey|access[-_ ]?key|private[-_ ]?key|signature|session|jwt';
/** Single-token schemes: credential is the next token (no minimum length — `Basic YTpi` is valid). */
const AUTH_SCHEME_RE = /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]+/gi;
/** List schemes (Digest, and anything else that carries a comma list): mask to end of line. */
const AUTH_LIST_SCHEME_RE = /\b(Digest|Negotiate|NTLM|AWS4-HMAC-SHA256)\s+[^\n]*/gi;
/**
 * A colon-delimited credential — `X-API-Key: …`, `"api_key":123456`, `API key: …`,
 * `Cookie: SID=a; LSID=b`, `Authorization: Digest …`. The value is masked to END OF
 * LINE: multi-value headers, digest parameter lists and multi-word values all leaked
 * a tail under narrower value patterns (rounds 4–5). Over-redaction of the rest of a
 * one-line message is the accepted price.
 */
const COLON_CREDENTIAL_RE = new RegExp(`["']?\\b((?:[\\w-]+[\\s_-])?(?:${SENSITIVE_STEMS})[\\w-]*)\\b["']?\\s*:\\s*(?!\\[REDACTED\\]\\s*$)[^\\n]*`, 'gi');

/**
 * Scheme + host of a URL token found in free text; the whole token is withheld when
 * it does not parse.
 * @param {string} token - e.g. 'https://hooks.slack.com/actions/T/B/SECRET;more' | 'https://u:p@api.x.test/v1?k=v'
 * @returns {string} 'https://hooks.slack.com' | 'https://api.x.test' | '<unparseable-url>'
 */
function hostOnly(token) {
  try {
    const parsed = new URL(String(token));
    return `${parsed.protocol}//${parsed.host}`;
  } catch (e) {
    return '<unparseable-url>';
  }
}

/**
 * Scrub what redactUrl does NOT cover in free text.
 *
 * @param {string} text - e.g. 'rejected {"next":"https://hooks.slack.com/actions/T/B/SECRET"} X-API-Key: SECRET2 with Bearer abc'
 * @returns {string} 'rejected {"next":"https://hooks.slack.com X-API-Key: [REDACTED] with Bearer [REDACTED]'
 */
function scrubAuthSchemes(text) {
  return String(text)
    .replace(AUTH_SCHEME_RE, '$1 [REDACTED]')
    .replace(AUTH_LIST_SCHEME_RE, '$1 [REDACTED]');
}

function scrubErrorText(text) {
  return scrubAuthSchemes(text)
    .replace(URL_IN_TEXT_RE, hostOnly)
    .replace(COLON_CREDENTIAL_RE, '$1: [REDACTED]');
}

/**
 * Secret-safe rendering of the `error` field. With the redactor available the text
 * (code, else message) is scrubbed — redactUrl pairs, then scrubErrorText — and
 * truncated. Without it (reportExceptions stubbed in require.cache) FAIL CLOSED:
 * only a provenance-known code is emitted (err.code or our `HTTP <status>`), never
 * message text, however code-like it looks.
 *
 * @param {{code?: string, message?: string}} parts - e.g. { code: 'ECONNRESET' } |
 *   { message: 'upstream said api_key=SECRET' } | { code: 'HTTP 503' }
 * @returns {string} 'ECONNRESET' | 'upstream said api_key=[REDACTED]' (redactor present) |
 *   '<error text withheld: redactor unavailable>' (redactor absent, no code)
 */
function safeErrorText(parts) {
  const { code, message } = (parts && typeof parts === 'object') ? parts : { message: parts };
  if (typeof redactUrl === 'function') {
    const text = code || message || 'request failed';
    // Auth schemes are scrubbed BEFORE redactUrl too: for `Authorization=Bearer TOPSECRET`
    // redactUrl's pair pass consumes the scheme word as the pair's value and the token
    // would otherwise survive unrecognised (Copilot on the port, round 5).
    return scrubErrorText(redactUrl(scrubAuthSchemes(String(text)))).slice(0, 160);
  }
  return (typeof code === 'string' && BARE_ERROR_CODE_RE.test(code)) ? code : '<error text withheld: redactor unavailable>';
}

/**
 * The SLOW threshold from LOGGED_HTTP_SLOW_MS. Zero is a VALID value (every call
 * is SLOW — useful when hunting); unset, blank, non-numeric or negative values
 * fall back to the default (Copilot on the port: `Number(env) || DEFAULT` discarded 0).
 *
 * @returns {number} e.g. 0 for '0', 2000 for undefined / '' / 'abc' / '-5'
 */
function slowThresholdMs() {
  const raw = process.env.LOGGED_HTTP_SLOW_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_SLOW_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SLOW_MS;
}

/**
 * Emit the one-line timing record for a single attempt. Takes the RAW `response` /
 * `err` and derives status/code/message INSIDE the never-throw guard — a rejected
 * object whose `code`/`message`/`response` getter throws must not escape into the
 * retry loop (Copilot on the port, round 3).
 *
 * @param {object} entry - e.g. { functionName: 'tomoCheck', method: 'patch',
 *   url: 'https://api.airtable.com/v0/appX/tomo_responses/rec1', attempt: 1,
 *   maxTries: 3, durationMs: 412, response: { status: 200 } }
 *   or { …, durationMs: 31, err: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }
 *   or { …, durationMs: 90, response: { status: 503 }, failed: true }
 */
function logTiming({ functionName, method, url, attempt, maxTries, durationMs, response, err, failed }) {
  // NEVER-THROW CONTRACT: this runs inside the retry loop's try/catch. A throw
  // here would turn a 2xx into a retried (duplicated) write, or replace the real
  // network error and skip the remaining retries + Slack report (adversarial
  // review 2026-10-07). Telemetry must not alter the call it observes.
  try {
    const slowMs = slowThresholdMs();
    // Defensive per-field reads: a rejected object whose getters throw still gets its
    // one line per attempt (with the details marked unreadable) instead of none
    // (Copilot on the port, round 4). Only the shape of what we read is trusted.
    const UNREADABLE = Symbol('unreadable');
    const safeRead = (obj, key) => { try { return obj == null ? undefined : obj[key]; } catch (e) { return UNREADABLE; } };
    const rawCode = err ? safeRead(err, 'code') : undefined;
    const rawMessage = err ? safeRead(err, 'message') : undefined;
    const rawResponse = err ? safeRead(err, 'response') : undefined;
    const rawStatus = response ? safeRead(response, 'status') : (rawResponse && rawResponse !== UNREADABLE ? safeRead(rawResponse, 'status') : undefined);
    const unreadable = [rawCode, rawMessage, rawResponse, rawStatus].includes(UNREADABLE);
    const status = Number.isFinite(rawStatus) ? rawStatus : undefined;
    const isFailure = Boolean(err) || Boolean(failed);
    let errorText;
    if (isFailure) {
      if (unreadable) {
        errorText = '<error details unreadable>';
      } else {
        const code = err
          ? (typeof rawCode === 'string' ? rawCode : undefined)
          : (status !== undefined ? `HTTP ${status}` : undefined);
        const message = typeof rawMessage === 'string' ? rawMessage : undefined;
        errorText = safeErrorText({ code, message });
      }
    }
    const record = {
      fn: functionName,
      method: String(method || 'get').toUpperCase(),
      target: timingTarget(url),
      attempt: `${attempt}/${maxTries}`,
      status: status ?? null,
      ms: durationMs,
      ...(isFailure ? { error: errorText } : {})
    };
    const slow = durationMs >= slowMs;
    const line = `loggedHttp timing${slow ? ' SLOW' : ''} ${JSON.stringify(record)}`;
    if (slow || isFailure) console.warn(line); else console.log(line);
  } catch (e) {
    // swallow — see contract above
  }
}

/**
 * Makes an HTTP request with retries and Slack file upload on final failure.
 *
 * Two calling styles are supported:
 *   loggedHttp(url, axiosConfig?, options?)   // url + axios-style config
 *   loggedHttp(axiosConfig, options?)          // single axios config object
 *
 * @returns {Promise<any>} - The parsed response body (response.data).
 */
async function loggedHttp(urlOrConfig, axiosConfigOrOptions = {}, maybeOptions) {
  let axiosConfig;
  let options;
  if (typeof urlOrConfig === 'string') {
    axiosConfig = { url: urlOrConfig, method: 'get', ...axiosConfigOrOptions };
    options = maybeOptions || {};
  } else {
    axiosConfig = urlOrConfig;
    options = axiosConfigOrOptions;
  }

  const {
    maxTries = 3,
    retryInterval = 30000, // ms
    slackChannel = process.env.SLACK_CHANNEL_ID,
    functionName = 'loggedHttp'
  } = options;

  // Per-attempt request timeout (parity fix, 2026-07-23 — authorized @MisterOctober):
  // the Node-RED logged_http subflow's http-request node enforced a default request
  // timeout, which the original port omitted — leaving every call unbounded (axios
  // default 0). A hung endpoint therefore consumed the entire Lambda budget with ZERO
  // retries. Bounding each attempt converts hangs into retryable failures (worst case
  // per call: 3 attempts x 30s + 2 x 30s sleeps = 150s). Default-when-absent: a
  // call-site may override by setting `timeout` in axiosConfig.
  axiosConfig.timeout = axiosConfig.timeout ?? 30000;

  let lastError;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const startedAt = Date.now();
    const timing = { functionName, method: axiosConfig.method, url: axiosConfig.url, attempt, maxTries };
    try {
      const response = await axios(axiosConfig);
      const durationMs = Date.now() - startedAt;
      if (response.status >= 200 && response.status < 300) {
        logTiming({ ...timing, response, durationMs });
        return response.data;
      } else {
        lastError = new Error(`HTTP ${response.status}: ${JSON.stringify(response.data)}`);
        lastError.response = response;
        logTiming({ ...timing, response, durationMs, failed: true });
      }
    } catch (err) {
      lastError = err;
      logTiming({ ...timing, err, durationMs: Date.now() - startedAt });
    }
    if (attempt < maxTries) {
      await new Promise(res => setTimeout(res, retryInterval));
    }
  }

  if (slackChannel) {
    await reportExceptionToSlack({
      error: lastError,
      channel: slackChannel,
      functionName,
      axiosConfig
    });
  }

  throw lastError;
}

// Add .get and .post convenience methods for compatibility with axios-like usage
loggedHttp.get = function(url, config = {}) {
  return loggedHttp({ method: 'get', url, ...config });
};
loggedHttp.post = function(url, data = {}, config = {}) {
  return loggedHttp({ method: 'post', url, data, ...config });
};

export default loggedHttp;
export const _timing = { timingTarget, logTiming, safeErrorText, scrubErrorText, slowThresholdMs, DEFAULT_SLOW_MS };
