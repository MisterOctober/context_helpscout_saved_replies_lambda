# Review Follow-Ups (2026-07-14)

## Confirmed Decisions
1. Partial data is NOT acceptable. Any detail-fetch failure must fail the invocation.
2. Send one Slack error notification per invocation failure (single context object per run).
3. Target Lambda runtime is Node 24.

## To-Do Items
1. [DONE] Remove per-reply Slack reporting in detail fetch path and aggregate failures for a single invocation-level alert.
2. [DONE] Change detail-fetch behavior so any reply detail error aborts the run (throw) instead of returning partial data.
3. [DONE] Ensure top-level handler emits exactly one reportExceptions call for a failed invocation before rethrowing.
4. [DONE] Add tests to enforce fail-on-any-detail-fetch-error behavior.
5. [DONE] Add tests to enforce one notification per invocation failure (avoid duplicate alerting between loggedHttp and handler).
6. [DONE] Review/redact sensitive fields in exception payloads sent to Slack (client_secret, authorization headers).
7. [DONE] Re-check deploy workflow formatting in build step to keep shell indentation clean and obvious.
8. [DONE] Keep package engine aligned with confirmed runtime (Node 24) and verify deployment image/runtime settings match.

## Notes
- Help Scout "List Saved Replies" docs currently show an array response and only `includeChatReplies` query param; no page/pageSize params or pagination links are documented.
- Pagination risk for this endpoint appears low from docs, but validate with a mailbox that has many saved replies if possible.
- Redaction key coverage in `utils/reportExceptions.js` was expanded after comparing an alternate implementation (added x-auth/proxy-authorization/passwd/credential/bearer/apikey variants).
