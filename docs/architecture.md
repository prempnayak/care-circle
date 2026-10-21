# Architecture

## Components

| Component | Local | AWS |
| --- | --- | --- |
| API (`packages/mcp-server`): `POST /mcp`, `/.well-known/*`, `/api/*`, `/dev/*`, `/healthz` | Node + Hono on :8787 | Same server in Lambda via the AWS Lambda Web Adapter, behind API Gateway HTTP API |
| Identity | `packages/dev-auth` on :8788 (OAuth 2.1, PKCE S256, `resource`, refresh, RS256 JWT) | Cognito user pool + managed login; our API serves the RFC 8414 facade |
| Data | DynamoDB Local | DynamoDB (on demand, PITR, TTL, KMS CMK) |
| Alerts | In-process queue + workers inside the API process | SQS + DLQ → notifier Lambda; EventBridge Scheduler for the sweep (5 min) and materializer (hourly) |
| Email | Mailpit (:8025) | SES |
| Dashboard / simulator UI | Vite dev servers (:5173 / :5174) | S3 + CloudFront |
| Simulator agent | Node + Hono on :8790 (scripted or Bedrock) | Lambda via the Web Adapter, `bedrock:InvokeModel` on one model |

Side effects sit behind interfaces chosen by env vars: `Queue` (memory/SQS), `Mailer` (SMTP/SES), `Crypto` (AES-GCM/KMS), `Clock` (system/adjustable).

## Request path: `tools/call check_in`

1. `POST /mcp` with `Authorization: Bearer <jwt>`.
2. The auth gate parses the JSON-RPC body. `initialize`, `ping`, `tools/list`, `resources/*`, notifications and `care_circle_help` pass without a token; any other `tools/call` without a valid token gets **401** with `{"error":"unauthorized",…}` and **no `WWW-Authenticate`**.
3. The JWT is verified locally (cached JWKS; `aws-jwt-verify` for Cognito: issuer, `token_use=access`, client id, expiry, scope `carecircle/circle`).
4. Routing: 2025-era clients (`2025-11-25`, `2025-03-26`) → a fresh `McpServer` on a stateless `WebStandardStreamableHTTPServerTransport` with JSON responses; 2026-era → the SDK's `createMcpHandler` in JSON mode.
5. Tool: one GSI1 query (profile + membership + circle snapshot) → one conditional `UpdateItem` → audit `PutItem` → (crisis or all-clear only) one SQS send.
6. Envelope: `content = [speech, JSON(structuredContent)]`, `structuredContent` validated against the declared `outputSchema`, `_meta.ui` for the card on `get_status` and `get_todays_doses`.

## Data model (one table `CareCircle`)

| Entity | PK | SK | Notes |
| --- | --- | --- | --- |
| User profile | `USER#<sub>` | `PROFILE` | firstName, email, join attempts; also in GSI1 (`USER#<sub>` / `PROFILE`) |
| Circle | `CIRCLE#<id>` | `META` | tz, window, grace, paused, members[], optimistic `version` |
| Member | `CIRCLE#<id>` | `MEMBER#<sub>` | role, alertOptIn, consentAt, **circle snapshot**; GSI1 `USER#<sub>` / `CIRCLE#<id>` |
| Medication | `CIRCLE#<id>` | `MED#<medId>` | displayName, aliases, times (no dosage or strength) |
| Check-in | `CIRCLE#<id>` | `DAY#<date>#CHECKIN` | status, at, lastAt, mood, noteCipher, crisis; GSI2 while open |
| Dose | `CIRCLE#<id>` | `DAY#<date>#DOSE#<HH:mm>#<medId>` | name/aliases snapshot, status, loggedAt, late; GSI2 while open |
| Message | `CIRCLE#<id>` | `MSG#<iso>#<rand>` | textCipher, crisis; TTL 90 days |
| Alert | `CIRCLE#<id>` | `ALERT#<type>#<itemKey>` | deterministic key → each alert sent once |
| Join code | `CODE#<6 digits>` | `META` | circleId, role; TTL 24 h |
| Audit | `CIRCLE#<id>` | `AUDIT#<iso>#<rand>` | actor, action, tool, ok — no payloads |

GSI2 (sparse) holds open deadlines: `DUE#<UTC date>` / `<deadline ISO>#<circleId>#<SK>`. The sweep queries it, flips `open → missed` conditionally (only the winner alerts), and removes the GSI2 keys.

## Scheduling

- **Materializer** creates today's and tomorrow's check-in and dose items per circle (idempotent conditional puts; never creates an already-overdue item). Dashboard edits re-materialize future items.
- **Sweep** marks overdue items missed and queues `missed_checkin` / `missed_dose` (none while paused).
- **Notifier** filters recipients by opt-in, claims `ALERT#…` with a conditional put, sends, and marks sent/failed (retries; DLQ after 3).

## Simulator = the Alexa+ stand-in

Entrants can't use Amazon's MCP Toolkit or Web Simulator, so `apps/simulator` behaves like Alexa: fresh MCP client per turn, 401 → PRM → AS metadata (S256 check) → authorization code + PKCE + `resource` with a static client id → token per persona → retry; refresh on expiry. It hosts the MCP App card with the ext-apps `AppBridge` in a sandboxed iframe and shows every HTTP exchange in a trace panel.
