# Architecture

## The system at a glance

![Care Circle architecture: Alexa+ or the simulator (Strands agent, local model or Bedrock) calls the MCP server on Lambda behind API Gateway; Cognito for sign-in; DynamoDB + KMS for data; EventBridge sweep, SQS and the notifier send SES email](images/architecture.png)

Editable source: the "Care Circle – Architecture" diagram in Eraser (cloud-architecture DSL).

## Components

| Component | Local | AWS |
| --- | --- | --- |
| API (`packages/mcp-server`): `POST /mcp`, `/.well-known/*`, `/api/*`, `/dev/*`, `/healthz` | Node + Hono on :8787 | Same server in Lambda via the AWS Lambda Web Adapter, behind API Gateway HTTP API |
| Identity | `packages/dev-auth` on :8788 (OAuth 2.1, PKCE S256, `resource`, refresh, RS256 JWT) | Cognito user pool + managed login; our API serves the RFC 8414 facade |
| Data | DynamoDB Local | DynamoDB (on demand, PITR, TTL, KMS CMK) |
| Alerts | In-process queue + workers inside the API process | SQS + DLQ → notifier Lambda; EventBridge Scheduler for the sweep (5 min) and materializer (hourly) |
| Email | Mailpit (:8025) | SES |
| Dashboard / simulator UI | Vite dev servers (:5173 / :5174) | For the demo they run on a laptop against the AWS API (Cognito allows `localhost` redirects); `CareCircleWeb` (S3 + CloudFront) is optional |
| Simulator agent (the Alexa+ stand-in) | Node + Hono on :8790; agent = **Strands** (model in LM Studio or on Bedrock), scripted rules, or a Bedrock Converse loop | Runs beside the UI; nothing model-related is deployed |

Side effects sit behind interfaces chosen by env vars: `Queue` (memory/SQS), `Mailer` (SMTP/SES), `Crypto` (AES-GCM/KMS), `Clock` (system/adjustable).

## Request path: `tools/call check_in`

1. `POST /mcp` with `Authorization: Bearer <jwt>`.
2. The auth gate parses the JSON-RPC body. `initialize`, `ping`, `tools/list`, `resources/*`, notifications and `care_circle_help` pass without a token; any other `tools/call` without a valid token gets **401** with `{"error":"unauthorized",…}` and **no `WWW-Authenticate`**.
3. The JWT is verified locally (cached JWKS; `aws-jwt-verify` for Cognito: issuer, `token_use=access`, client id, expiry, scope `carecircle/circle`).
4. Routing: 2025-era clients (`2025-11-25`, `2025-03-26`) → a fresh `McpServer` on a stateless `WebStandardStreamableHTTPServerTransport` with JSON responses; 2026-era → the SDK's `createMcpHandler` in JSON mode. A `GET /mcp` (SSE stream) gets **405**, as the spec requires of a stateless server.
5. Tool: one GSI1 query (profile + membership + circle snapshot) → one conditional `UpdateItem` → audit `PutItem` → (crisis or all-clear only) one SQS send. Waiting family messages are read in the same transaction as the audit write.
6. Envelope: `content = [speech, JSON(structuredContent)]`, `structuredContent` validated against the declared `outputSchema`, `_meta.ui` for the card on `get_status` and `get_todays_doses`.

## Family messages, both ways (no new tool)

- **From the cared-for person:** `message_circle` stores the text KMS-encrypted (`MSG#…`), queues a `message` email to opted-in family, and shows it on the dashboard. It's never spoken to a caregiver.
- **To the cared-for person:** a family member's `message_circle` ("Tell Mom I'll call at 6") stores the message (`MSG#…`, `toRecipient`) and appends `{fromName, textCipher}` to the cared-for person's member item (`inbox`, at most 2 waiting; a conditional `list_append`). Her next `check_in` or `get_status` reads them aloud and removes them in the same transaction, so a message is read once.

## Tap-to-log on the card

The card's `today` data carries dose IDs and `canLog` only on the cared-for person's own card. **Log it** calls `log_dose` with `dose_id` through the MCP Apps host (`app.callServerTool` → host `oncalltool`), which forwards it with her token. It's the same tool, rules and audit as saying "I took my metformin".

## Data model (one table `CareCircle`)

| Entity | PK | SK | Notes |
| --- | --- | --- | --- |
| User profile | `USER#<sub>` | `PROFILE` | firstName, email, join attempts; also in GSI1 (`USER#<sub>` / `PROFILE`) |
| Circle | `CIRCLE#<id>` | `META` | tz, window, grace, paused, members[], optimistic `version` |
| Member | `CIRCLE#<id>` | `MEMBER#<sub>` | role, alertOptIn, consentAt, **circle snapshot**, `inbox` (waiting family messages, recipient only); GSI1 `USER#<sub>` / `CIRCLE#<id>` |
| Medication | `CIRCLE#<id>` | `MED#<medId>` | displayName, aliases, times (no dosage or strength) |
| Check-in | `CIRCLE#<id>` | `DAY#<date>#CHECKIN` | status, at, lastAt, mood, noteCipher, crisis; GSI2 while open |
| Dose | `CIRCLE#<id>` | `DAY#<date>#DOSE#<HH:mm>#<medId>` | name/aliases snapshot, status, loggedAt, late; GSI2 while open |
| Message | `CIRCLE#<id>` | `MSG#<iso>#<rand>` | textCipher, from, `toRecipient`, crisis; TTL 90 days |
| Alert | `CIRCLE#<id>` | `ALERT#<type>#<itemKey>` | deterministic key → each alert sent once |
| Join code | `CODE#<6 digits>` | `META` | circleId, role; TTL 24 h |
| Audit | `CIRCLE#<id>` | `AUDIT#<iso>#<rand>` | actor, action, tool, ok — no payloads |

GSI2 (sparse) holds open deadlines: `DUE#<UTC date>` / `<deadline ISO>#<circleId>#<SK>`. The sweep queries it, flips `open → missed` conditionally (only the winner alerts), and removes the GSI2 keys.

## Scheduling

- **Materializer** creates today's and tomorrow's check-in and dose items per circle (idempotent conditional puts; never creates an already-overdue item). Dashboard edits re-materialize future items.
- **Sweep** marks overdue items missed and queues `missed_checkin` / `missed_dose` (none while paused).
- **Notifier** filters recipients by opt-in, claims `ALERT#…` with a conditional put, sends, and marks sent/failed (retries; DLQ after 3).

## Simulator = the Alexa+ stand-in

Entrants can't use Amazon's MCP Toolkit or Web Simulator, so `apps/simulator` behaves like Alexa:
- **Account linking:** a fresh MCP client per turn. On a 401 it goes PRM → AS metadata (S256 check) → authorization code + PKCE + `resource` with a static client id → a token per persona → retry, and it refreshes tokens on expiry. In the cloud, each link first clears Cognito's session cookie (`/logout`), so a persona never links as the last signed-in user.
- **Card and trace:** it hosts the MCP App card with the ext-apps `AppBridge` in a sandboxed iframe (the bridge listens before the card loads) and shows every HTTP exchange in a trace panel.

### The agent (`SIM_AGENT`)

- **`strands`:** an AWS Strands Agents SDK agent. Its system prompt is the Agent Skill plus Alexa rules. Its tools are Care Circle's MCP tools from `tools/list`, wrapped as Strands `FunctionTool`s that call through the simulator's MCP client, so linking, trace and card are unchanged. The model is a setting: LM Studio's OpenAI-compatible server (Qwen 3 8B) or `BedrockModel`.
  - **One tool per turn.** Alexa speaks Care Circle's reply as written, which keeps the voice rules and halves the turn time.
  - **Crisis safety net:** `matchCrisis` runs before the model, so injury or self-harm wording always reaches `check_in`.
  - **Minimal memory:** the model sees earlier turns only when Alexa just asked something ("Want to log it?"), so it can't repeat stale answers.
- **`scripted`:** regex routing; no model.
- **`bedrock`:** a hand-written Converse loop, kept for comparison.

## Measured latency (AWS, Oct 23, 2026)

API Gateway's own CloudWatch metrics for a controlled run (5 tools: help, status, week summary, today's doses, log_dose), measured from the moment a request reaches AWS:

| Load | Requests | p50 | p95 | p99 | Cold starts | 5xx |
| --- | --- | --- | --- | --- | --- | --- |
| One at a time | 530 | 36 ms | 62 ms | 85 ms | 0 | 0 |
| 10 at a time | 885 | 38 ms | 65 ms | 140 ms | 0 | 0 |

Care Circle's own code (Lambda `Duration`) takes 19–22 ms at p50. A cold start adds 0.65–0.94 s to the first request on a new Lambda environment. From a laptop in India the same calls take about 300 ms, almost all of it network distance to us-east-1.
