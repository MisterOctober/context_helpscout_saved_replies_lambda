import axios from 'axios';
import { reportExceptionToSlack } from './reportExceptions.js';

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
    try {
      const response = await axios(axiosConfig);
      if (response.status >= 200 && response.status < 300) {
        return response.data;
      } else {
        lastError = new Error(`HTTP ${response.status}: ${JSON.stringify(response.data)}`);
        lastError.response = response;
      }
    } catch (err) {
      lastError = err;
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