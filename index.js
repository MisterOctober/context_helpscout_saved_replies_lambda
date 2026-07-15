import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import defaultLoggedHttp from "./utils/loggedHttp.js";
import defaultReportExceptions from "./utils/reportExceptions.js";

const defaultS3 = new S3Client();
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stepStart(label) {
	const t0 = Date.now();
	console.log(`[${label}] start`);
	return (msg, data) => {
		const size = Array.isArray(data) ? `, ${data.length} items` : "";
		console.log(`[${label}] ${msg} (${Date.now() - t0}ms${size})`);
	};
}

function parseSavedRepliesListResponse(response) {
	if (Array.isArray(response)) {
		return { items: response, nextUrl: null };
	}

	if (!response || typeof response !== "object") {
		return { items: [], nextUrl: null };
	}

	const items = response._embedded?.savedReplies || response.savedReplies || [];
	const nextUrl = response._links?.next?.href || null;

	return {
		items: Array.isArray(items) ? items : [],
		nextUrl: typeof nextUrl === "string" ? nextUrl : null
	};
}
async function fetchSavedRepliesList(initialUrl, helpscoutToken, httpClient) {
	const headers = {
		Authorization: `Bearer ${helpscoutToken}`,
		"Content-Type": "application/json; charset=UTF-8"
	};
	const options = {
		slackChannel: null,
		functionName: "savedRepliesList"
	};
	const allReplies = [];
	const visitedUrls = new Set();
	let url = initialUrl;

	while (url) {
		if (visitedUrls.has(url)) {
			throw new Error(`Detected pagination loop for saved replies URL: ${url}`);
		}

		visitedUrls.add(url);
		const response = await httpClient(url, { headers }, options);
		const responseShape = Array.isArray(response)
			? `array(${response.length})`
			: response && typeof response === "object"
				? `object keys=[${Object.keys(response).join(", ")}]`
				: typeof response;
		console.log(`[savedRepliesList] raw response shape: ${responseShape}`);

		const { items, nextUrl } = parseSavedRepliesListResponse(response);
		allReplies.push(...items);
		url = nextUrl;
	}

	return allReplies;
}

async function fetchAllSavedReplies(savedRepliesList, helpscoutToken, httpClient, timing = {}) {
	const helpscoutMailboxId = process.env.HELPSCOUT_MAILBOX_ID;
	if (!helpscoutToken || !savedRepliesList.length) {
		return [];
	}
	const rateLimitMs = timing.rateLimitMs ?? 500;
	const sleep = timing.sleep ?? defaultSleep;
	const now = timing.now ?? Date.now;
	const options = {
		slackChannel: null,
		functionName: "savedRepliesDetails"
	};

	const results = [];
	let nextAllowedRequestAt = 0;

	const rateLimitedHttpRequest = async (url, config) => {
		const currentTime = now();
		if (currentTime < nextAllowedRequestAt) {
			await sleep(nextAllowedRequestAt - currentTime);
		}
		nextAllowedRequestAt = Math.max(nextAllowedRequestAt, now()) + rateLimitMs;
		return httpClient(url, config, options);
	};

	for (const reply of savedRepliesList) {
		const candidateUrls = [
			(helpscoutMailboxId && reply?.id)
				? `https://api.helpscout.net/v2/mailboxes/${helpscoutMailboxId}/saved-replies/${reply.id}`
				: null,
			reply?._links?.self?.href,
			reply?.id ? `https://api.helpscout.net/v2/saved-replies/${reply.id}` : null
		].filter(Boolean);

		if (!candidateUrls.length) {
			throw new Error("No valid saved reply detail URL could be constructed");
		}

		let lastError;
		for (const url of [...new Set(candidateUrls)]) {
			try {
				const detail = await rateLimitedHttpRequest(url, {
					headers: {
						Authorization: `Bearer ${helpscoutToken}`,
						"Content-Type": "application/json; charset=UTF-8"
					}
				});
				results.push(detail);
				lastError = null;
				break;
			} catch (err) {
				lastError = err;
				if (err?.response?.status !== 404) {
					throw err;
				}
			}
		}

		if (lastError) {
			throw lastError;
		}
	}

	return results;
}

async function getHelpScoutToken(httpClient) {
	const options = {
		slackChannel: null,
		functionName: "helpScoutToken"
	};
	const cache = global.helpscoutTokenCache || { token: null, timestamp: 0 };
	const now = Date.now();

	if (cache.token && now - cache.timestamp < 110 * 60 * 1000) {
		return cache.token;
	}

	const resp = await httpClient("https://api.helpscout.net/v2/oauth2/token", {
		method: "POST",
		data: {
			grant_type: "client_credentials",
			client_id: process.env.HELPSCOUT_CLIENT_ID,
			client_secret: process.env.HELPSCOUT_CLIENT_SECRET
		}
	}, options);

	global.helpscoutTokenCache = {
		token: resp.access_token,
		timestamp: now
	};

	return resp.access_token;
}

export const handler = async (event, context, deps = {}) => {
	const loggedHttp = deps.loggedHttp ?? defaultLoggedHttp;
	const s3 = deps.s3 ?? defaultS3;
	const reportExceptions = deps.reportExceptions ?? defaultReportExceptions;
	const sleep = deps.sleep ?? defaultSleep;
	const now = deps.now ?? Date.now;
	const savedRepliesRateLimitMs = deps.savedRepliesRateLimitMs ?? 500;

	console.log("Help Scout standalone lambda triggered:", JSON.stringify(event));

	const HS_SAVED_REPLIES_URL = `https://api.helpscout.net/v2/mailboxes/${process.env.HELPSCOUT_MAILBOX_ID}/saved-replies`;

	try {
		let helpscoutToken;
		const log = stepStart("helpScoutToken");
		helpscoutToken = await getHelpScoutToken(loggedHttp);
		log(helpscoutToken ? "obtained" : "no token returned");

		let savedRepliesList = [];
		if (helpscoutToken) {
			const log = stepStart("savedRepliesList");
			savedRepliesList = await fetchSavedRepliesList(HS_SAVED_REPLIES_URL, helpscoutToken, loggedHttp);
			log("fetched", savedRepliesList);
		}

		let savedReplies = [];
		if (savedRepliesList.length > 0) {
			const log = stepStart("savedRepliesDetails");
			savedReplies = await fetchAllSavedReplies(savedRepliesList, helpscoutToken, loggedHttp, {
				rateLimitMs: savedRepliesRateLimitMs,
				sleep,
				now
			});
			log("fetched", savedReplies);
		}

		if (savedReplies.length > 0) {
			const log = stepStart("savedReplies S3");
			await s3.send(
				new PutObjectCommand({
					Bucket: "lambda-prod-bucket-v2",
					Key: "saved_replies.json",
					Body: JSON.stringify(savedReplies),
					ContentType: "application/json"
				})
			);
			log("wrote to S3");
		}
	} catch (err) {
		await reportExceptions(err, { functionName: "handler" });
		throw err;
	}

	return {
		statusCode: 200,
		body: JSON.stringify({ message: "Help Scout saved replies update completed." })
	};
};

