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
/** A bare error code: `ECONNRESET`, `EAI_AGAIN`, `ERR_BAD_RESPONSE`, `HTTP 503`. */
const BARE_ERROR_CODE_RE = /^(?:[A-Z][A-Z0-9_]{2,}|HTTP \d{3})$/;

/**
 * Secret-safe rendering of a request URL for the timing line.
 * @param {string} url - e.g. 'https://x.api-us1.com/admin/api.php?api_key=SECRET&api_action=contact_list'
 * @returns {string} 'https://x.api-us1.com/admin/api.php' (query dropped);
 *   'https://hooks.slack.com/<redacted>' for capability-URL hosts; '<unparseable-url>' otherwise
 */
function timingTarget(url) {
  try {
    const parsed = new URL(String(url));
    const isCapabilityHost = /(^|\.)(web)?hooks?\./i.test(parsed.host);
    return `${parsed.protocol}//${parsed.host}${isCapabilityHost ? '/<redacted>' : parsed.pathname}`;
  } catch (e) {
    return '<unparseable-url>';
  }
}

/**
 * Any URL embedded in free text, and Bearer/Basic/token credentials (Copilot on the
 * port, 2026-10-07, two rounds). The URL match runs to the next WHITESPACE on
 * purpose: userinfo may legally contain `)` `"` `'` `<` `>`, and a matcher that
 * stopped there left the rest of a password in clear after `<unparseable-url>`.
 * Trailing prose punctuation is therefore swallowed into the token — a harmless
 * over-match (the whole token is either rendered host+path or `<unparseable-url>`).
 * The credential match has NO minimum length: `Basic YTpi` (a:b) is a valid
 * credential. Over-redaction of an innocent "token expired" is accepted.
 */
const URL_IN_TEXT_RE = /https?:\/\/\S+/gi;
const AUTH_SCHEME_RE = /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Scrub what redactUrl does NOT cover in free text: embedded URLs are reduced to
 * their timing-target form (host + path, capability-host paths redacted, userinfo
 * and query dropped) and auth-scheme credentials are masked.
 *
 * @param {string} text - e.g. 'rejected https://hooks.slack.com/actions/T/B/SECRET with Bearer abcdefghijkl'
 * @returns {string} 'rejected https://hooks.slack.com/<redacted> with Bearer [REDACTED]'
 */
function scrubErrorText(text) {
  return String(text)
    .replace(URL_IN_TEXT_RE, (url) => timingTarget(url))
    .replace(AUTH_SCHEME_RE, '$1 [REDACTED]');
}

/**
 * Secret-safe rendering of the `error` field: redactUrl pairs, then scrubErrorText for
 * embedded URLs and auth-scheme credentials, then truncated — with the redactor;
 * bare codes only (free text withheld) without it.
 * @param {*} error - e.g. 'ECONNRESET' | 'upstream said api_key=SECRET' | 'HTTP 503'
 * @returns {string}
 */
function safeErrorText(error) {
  const text = String(error);
  if (typeof redactUrl === 'function') return scrubErrorText(redactUrl(text)).slice(0, 160);
  return BARE_ERROR_CODE_RE.test(text) ? text : '<error text withheld: redactor unavailable>';
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
 * Emit the one-line timing record for a single attempt (never throws).
 * @param {object} entry - e.g. { functionName: 'persistOrder', method: 'post',
 *   url: 'http://pg:3000/rpc/upsert_record', attempt: 1, maxTries: 3, status: 200, durationMs: 412 }
 */
function logTiming({ functionName, method, url, attempt, maxTries, status, durationMs, error }) {
  try {
    const slowMs = slowThresholdMs();
    const record = {
      fn: functionName,
      method: String(method || 'get').toUpperCase(),
      target: timingTarget(url),
      attempt: `${attempt}/${maxTries}`,
      status: status ?? null,
      ms: durationMs,
      ...(error ? { error: safeErrorText(error) } : {})
    };
    const slow = durationMs >= slowMs;
    const line = `loggedHttp timing${slow ? ' SLOW' : ''} ${JSON.stringify(record)}`;
    if (slow || error) console.warn(line); else console.log(line);
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
        logTiming({ ...timing, status: response.status, durationMs });
        return response.data;
      } else {
        lastError = new Error(`HTTP ${response.status}: ${JSON.stringify(response.data)}`);
        lastError.response = response;
        logTiming({ ...timing, status: response.status, durationMs, error: `HTTP ${response.status}` });
      }
    } catch (err) {
      lastError = err;
      logTiming({ ...timing, status: err?.response?.status, durationMs: Date.now() - startedAt, error: err?.code || err?.message || 'request failed' });
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
