import axios from 'axios';
import FormData from 'form-data';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /(authorization|x-auth|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|credential|bearer|api[-_]?key|apikey|client[-_]?secret)/i;

function redactSensitive(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }

  const redactedObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      redactedObject[key] = REDACTED;
      continue;
    }

    redactedObject[key] = redactSensitive(nestedValue, seen);
  }

  return redactedObject;
}

/**
 * Uploads an error payload as a file to Slack and posts it to a channel.
 * Tries external upload flow first (getUploadURLExternal + completeUploadExternal),
 * then falls back to chat.postMessage with the payload inlined as a code block
 * (Slack retired files.upload — it now returns `method_deprecated`).
 * @param {object} params
 * @param {object} params.error - The error object to report.
 * @param {string} params.channel - Slack channel ID (e.g., 'C019CH6T08Y').
 * @param {string} params.functionName - Name of the function for context.
 * @param {object} params.axiosConfig - The original Axios config for context.
 */
export async function reportExceptionToSlack({ error, channel, functionName, axiosConfig }) {
  const chan = channel || process.env.SLACK_CHANNEL_ID || 'C019CH6T08Y';
  const token = process.env.THERABOT2_TOKEN || process.env.SLACK_BOT_TOKEN;
  try {
    console.log(`Reporting exception to Slack channel ${chan} from function ${functionName}`);
    if (!token) throw new Error('Slack token env not set (THERABOT2_TOKEN or SLACK_BOT_TOKEN)');

    const errorText = JSON.stringify({
      message: error?.message,
      stack: error?.stack,
      response: error?.response && {
        status: error.response.status,
        data: redactSensitive(error.response.data),
        headers: redactSensitive(error.response.headers)
      },
      config: redactSensitive(axiosConfig)
    }, null, 2);

    let initialComment = `*Exception* in function \`${functionName}\``;
    if (error?.message) initialComment += `\n*Error*: \`${error.message}\``;
    if (axiosConfig?.url) initialComment += `\n*URL*: ${axiosConfig.url}`;
    if (axiosConfig?.method) initialComment += `\n*Method*: ${axiosConfig.method}`;

    // 1) Try modern external upload API.
    // NOTE (bug fix 2026-07-23, authorized @MisterOctober): files.getUploadURLExternal
    // does NOT accept application/json — arguments must be form-encoded, or Slack
    // replies { ok: false, error: 'invalid_arguments' }. The original JSON-body call
    // therefore failed silently on every invocation, leaving exception reporting dark.
    try {
      const getUrlResp = await axios.post(
        'https://slack.com/api/files.getUploadURLExternal',
        new URLSearchParams({
          filename: 'error_payload.json',
          length: String(Buffer.byteLength(errorText)),
          snippet_type: 'javascript'
        }).toString(),
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      if (getUrlResp.data?.ok && getUrlResp.data?.upload_url && getUrlResp.data?.file_id) {
        const uploadUrl = getUrlResp.data.upload_url;
        const fileId = getUrlResp.data.file_id;
        const form = new FormData();
        form.append('file', Buffer.from(errorText), { filename: 'error_payload.json', contentType: 'application/json' });
        await axios.post(uploadUrl, form, { headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` } });
        await axios.post('https://slack.com/api/files.completeUploadExternal', {
          files: [{ id: fileId }],
          channel_id: chan,
          initial_comment: initialComment
        }, { headers: { Authorization: `Bearer ${token}` } });
        return;
      }
      // A not-ok response does NOT throw, so log it explicitly — otherwise the
      // reason for falling back is invisible (this exact silence hid the
      // invalid_arguments bug above for months).
      console.warn('files.getUploadURLExternal returned not-ok:', getUrlResp.data);
    } catch (e) {
      console.warn('External upload flow failed, falling back to chat.postMessage:', e?.response?.data || e.message);
    }

    // 2) Fallback: Slack retired files.upload (it now returns `method_deprecated`),
    // so degrade to chat.postMessage with the payload inlined as a code block.
    // Truncated to stay comfortably under Slack's per-message text limits; the
    // full payload is always in the CloudWatch log (console.error at the call site).
    const MAX_INLINE_PAYLOAD = 8000;
    const inlinePayload = errorText.length > MAX_INLINE_PAYLOAD
      ? `${errorText.slice(0, MAX_INLINE_PAYLOAD)}\n… [truncated — full payload in CloudWatch]`
      : errorText;
    const slackResponse = await axios.post('https://slack.com/api/chat.postMessage', {
      channel: chan,
      text: `${initialComment}\n\`\`\`${inlinePayload}\`\`\``
    }, { headers: { Authorization: `Bearer ${token}` } });

    if (!slackResponse.data?.ok) {
      console.error('chat.postMessage fallback failed:', slackResponse.data);
    } else {
      console.log('Slack API response:', slackResponse.data);
    }
  } catch (slackErr) {
    console.error('Failed to send error file to Slack:', slackErr.message);
    if (slackErr.response && slackErr.response.data) {
      console.error('Slack API error response:', slackErr.response.data);
    }
  }
}

// Primary reporter used across handlers. Logs locally and best-effort posts payload to Slack.
export default async function reportExceptions(err, context = {}) {
  console.error('Exception:', err, context);
  try {
    // Only attempt Slack when tokens are present to avoid noisy test logs
    if (process.env.THERABOT2_TOKEN || process.env.SLACK_BOT_TOKEN) {
      await reportExceptionToSlack({
        error: err,
        functionName: context.functionName,
        axiosConfig: context.axiosConfig,
        channel: context.channel
      });
    }
  } catch (slackErr) {
    console.error('reportExceptionToSlack failed:', slackErr.message);
  }
}