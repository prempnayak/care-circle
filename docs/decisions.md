# Decisions

## MCP SDK v2 instead of `@modelcontextprotocol/sdk` v1 (Oct 1)
The handoff names `@modelcontextprotocol/sdk`. The current line is v2, split into `@modelcontextprotocol/server`, `/client`, `/core` (2.2.0), and `@modelcontextprotocol/ext-apps` 2.x requires v2 as a peer. We use v2.

## 2025-era requests use our own stateless JSON transport (Oct 1)
`createMcpHandler` serves 2025-era clients through a stateless fallback that answers with **SSE** (`text/event-stream`), verified with a probe. Amazon wants JSON. So `POST /mcp` routes with `isLegacyRequest`: 2025-era (2025-11-25 and 2025-03-26) → a per-request `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`; 2026-07-28 traffic → `createMcpHandler(factory, { legacy: 'reject', responseMode: 'json' })`.

## Tool input validation happens in the tool, not the SDK (Oct 1)
The SDK's validation failure text ("Input validation error: … Too big: expected string to have <=140 characters") would be spoken to users. Tools register a wrapper (`publishedSchema`) that publishes the zod JSON Schema but passes arguments through; `runTool` validates with the same zod schema and answers with speakable copy.

## HTTP framework: Hono + @hono/node-server (Oct 1)
Web-standard `Request`/`Response` matches the SDK's web-standard transport directly.

## One `app` container locally (Oct 1)
dev-auth's issuer must be `http://localhost:8788` for both the browser and the API's JWKS fetch, so all Node services share one container; DynamoDB Local and Mailpit are separate. Workers run inside the API process (`RUN_WORKERS=true`) so the in-memory queue and the dev clock are shared.

## Member items carry a circle snapshot (Oct 1)
To keep tools at ≤3 DynamoDB calls, each MEMBER item stores a snapshot (tz, window, names, paused) so one GSI1 query answers "who am I and where". META writes refresh snapshots in the same transaction with an optimistic `version`. The user PROFILE item is also in GSI1 so the same query returns join-attempt counts. Exception: `join_circle` confirm = 4 calls (identity and code lookups run in parallel, so 3 round trips).

## Copy decisions (Oct 1)
- Names instead of pronouns (we don't know anyone's pronouns): "Margaret's check-in window ended at 10:00 am."
- Crisis reply is two sentences: "I'm sorry, Margaret; if you're hurt or need help now, call 911. I'm letting Sarah and Tom know." ("letting … know", since the email is queued, not yet sent.)
- The medical disclaimer is in `structuredContent.disclaimer`, the dashboard footer and the README, not spoken (2-sentence limit).
- Crisis while paused: redirect spoken, family **not** emailed, and the reply says so. Messages still go out while paused (an explicit request).

## Materializer skips already-overdue items (Oct 1)
A brand-new circle or medicine shouldn't alert about this morning. The demo seed uses `includeOverdue` so today looks like a running circle.

## `seed:fresh` = only Sarah's profile (Oct 1)
So the J1 recording can show her creating the circle on the dashboard.

## Scale limit: materializer scans circle META items (Oct 1)
Acceptable at hackathon scale (handoff §9).

## Simulator agent runs server-side, as Alexa's cloud does (Oct 1)
The agent backend (not the browser) holds each persona's tokens, completes linking at `/link/callback`, and proxies the demo controls so the dev key never reaches the browser. The card is hosted in a sandboxed iframe through the ext-apps `AppBridge`; it is remounted for every result so it always matches the latest speech.

## Bedrock agent uses the Converse API directly (Oct 1)
The Strands Agents SDK has a TypeScript package, but the Converse loop is small, maps 1:1 to MCP tool calls, and can't be exercised until model access is approved. Revisit Strands after the Bedrock spike if time allows.

## Quality gates that need a running stack are scripts, not unit tests (Oct 1)
`test:inspector`, `test:latency`, `test:a11y` (Playwright + axe) and `test:load` (k6) run against `npm run dev` or a deployed URL; CI runs lint, typecheck, unit (with coverage), contract, the voice suites and the builds.

## CDK: two-step deploy for URLs (Oct 1)
The PRM `resource`, issuer facade and OAuth redirect URIs need the public URLs, which an HTTP API only has after the first deploy. Context values feed the second deploy (`infra/README.md`). A custom domain removes the second step.

## LICENSE: MIT, copyright Prem Nayak (Oct 1)
The handoff's default; confirm before making the repo public.

## AWS deploy and the Cognito `resource` spike (Oct 20)
Deployed Data, Auth, Workers and Api to us-east-1 in ~6 min + a 77 s second deploy for `publicBaseUrl`.
API Gateway HTTP API URL (MCP at /mcp). Cold start ~2.1 s on the first call.
Live checks pass: PRM, RFC 8414 facade (S256), initialize 2025-03-26, help without a token, 401 with no WWW-Authenticate, MCP Inspector 4/4.
Spike: Cognito's `/oauth2/authorize` accepts `resource=<api>/mcp` (302 to the managed login page, parameter kept), so we use **option (a)**, straight at Cognito. The token endpoint also accepted it on the first real sign-ins (Oct 21), so no proxy is deployed.
