import axios from 'axios';
import { reportExceptionToSlack } from './reportExceptions.js';

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
// webhook.botpress.cloud), where the path IS the credential. The `error` field is a
// provenance-known CODE only — message text is never logged here (see errorCodeText).
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
 * `ERR_BAD_RESPONSE`) or by us (`HTTP 503`). Shape check on a value whose provenance
 * is already `err.code` — never used to classify free text.
 */
const BARE_ERROR_CODE_RE = /^(?:[A-Z][A-Z0-9_]{2,39}|HTTP \d{3})$/;

/**
 * The timing line's `error` field: a provenance-known CODE ONLY.
 *
 * DESIGN RULING (Copilot on the port, 2026-10-07, six rounds): `err.message` is
 * arbitrary free text — camelCase credential labels, delimiter-less `API key SECRET`,
 * multiline PEM values, spaced `name=value`, compact JSON, capability URLs — and
 * every pattern list proposed in review leaked something the next round. Free text
 * cannot be made secret-safe by pattern, so this line never carries it. What it
 * carries is enough to attribute a slow or failing dependency: the structured
 * `target` (host + path), `status`, `ms`, and this code. The message itself still
 * reaches the error channel through reportExceptions, whose redaction policy is the
 * owner-adjudicated one for that surface.
 *
 * @param {{code?: *, status?: number}} parts - e.g. { code: 'ECONNRESET' } | { status: 503 } | {}
 * @returns {string} 'ECONNRESET' | 'HTTP 503' | 'request failed'
 */
function errorCodeText({ code, status } = {}) {
  if (typeof code === 'string' && BARE_ERROR_CODE_RE.test(code)) return code;
  if (Number.isFinite(status)) return `HTTP ${status}`;
  return 'request failed';
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
    const unreadable = [rawCode, rawMessage, rawResponse, rawStatus].includes(UNREADABLE); // message is read only to detect hostile getters — never logged
    const status = Number.isFinite(rawStatus) ? rawStatus : undefined;
    const isFailure = Boolean(err) || Boolean(failed);
    let errorText;
    if (isFailure) {
      errorText = unreadable
        ? '<error details unreadable>'
        : errorCodeText({ code: err ? rawCode : undefined, status });
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
export const _timing = { timingTarget, logTiming, errorCodeText, slowThresholdMs, DEFAULT_SLOW_MS };
