# Security

## Controls

| Area | Control |
| --- | --- |
| Transport | TLS everywhere in AWS (API Gateway, CloudFront, Cognito). Local mode is http on localhost only. |
| Authentication | OAuth 2.1 authorization code + PKCE S256 + `resource`; bearer tokens in the `Authorization` header only (never the query string). Tokens are verified locally: issuer, audience/client id, `token_use=access`, expiry, scope `carecircle/circle`. Expired or invalid → 401 so Alexa re-links. |
| Authorization | Data is scoped to the token's `sub` through circle membership. Roles (recipient/admin/member) are enforced in each tool and API route. A wrong role gets a speakable error, never another person's data. |
| Encryption at rest | DynamoDB with a KMS customer-managed key (rotation on). Notes and messages are additionally field-encrypted (KMS `Encrypt` with encryption context `{circleId}`; AES-256-GCM with the circle id as AAD locally). |
| Least privilege | One IAM role per function: the sweep can't send email, the notifier can't write to the queue, the API can't call SES, the simulator agent may invoke one Bedrock model. |
| Secrets | No secrets in the repo. `.env` is gitignored; `npm run dev` generates local keys. In AWS: the Cognito client secret stays in Cognito; the demo dev key is a Secrets Manager secret (demo context only; passed to the function as an environment variable, encrypted at rest). |
| Logging | JSON logs through a redacting logger: note text, messages, tokens, codes and email addresses are removed by key and by pattern (JWTs, bearer headers, emails). `packages/core/src/logger.test.ts` enforces it. |
| Audit | An audit record (actor, action, tool, ok; no payload) for every tool call and dashboard write; 13-month TTL. |
| Dev controls | `/dev/*` exists only with `DEV_ENDPOINTS=true` and needs `X-Dev-Key` (constant-time compare). Off by default in CDK; on only with `-c demo=true`. |
| Abuse limits | Join codes: 6 digits, single use, 24 h, role-bound; 5 wrong codes per hour locks the user for an hour. Free text is capped at 140 characters; `mood` is an enum. |
| Third-party code | No advertising or analytics SDKs (an ESLint rule blocks common ones). `npm audit`: one high-severity advisory in `brace-expansion` bundled inside `aws-cdk-lib` (build-time only, not shipped to Lambda). |
| Retention | Check-ins, doses, alerts and audit: 13 months (TTL). Messages: 90 days. Join codes: 24 h. Deleting the account of the person Care Circle looks after (or the circle's creator) deletes the whole circle synchronously. |

## Regulatory context

Care Circle isn't a HIPAA covered entity, but the FTC Health Breach Notification Rule has applied to health apps outside HIPAA since July 29, 2024. That is why there are no ad or analytics SDKs, data is minimized (no drug details, no device data), and there is a breach runbook below.

## Breach runbook

1. **Contain (first hour).** Rotate the Cognito app client secret and revoke refresh tokens (`AdminUserGlobalSignOut` for affected users); disable the API alias or set the HTTP API stage throttling to 0; rotate the dev key; snapshot logs.
2. **Assess (first 24 hours).** Use CloudTrail (KMS `Decrypt` calls by role and encryption context `circleId`), DynamoDB PITR, and the audit records to determine which circles and which data types (check-ins, notes, messages, emails) were exposed.
3. **Recover.** Restore the table from PITR if data was altered; redeploy from a clean commit; rotate the KMS key if key misuse is suspected.
4. **Notify.** Under the FTC Health Breach Notification Rule, notify affected individuals without unreasonable delay and within 60 calendar days of discovery; notify the FTC (within 60 days if ≥ 500 people, otherwise in the annual log); notify media if ≥ 500 residents of one state. Use plain language: what happened, what data, what we're doing, what they can do.
5. **Review.** Write a post-incident review in `docs/` and add a regression test.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository.
