# Friction log

### Amazon's lifecycle sample uses an older protocol version
- **Task attempted:** Match the protocol version Alexa+ sends in `initialize`.
- **Steps taken:** Read the Client Lifecycle page and the Functional Requirements.
- **Expected:** One protocol version across the docs.
- **Actual:** The sample `initialize` sends `2025-03-26`; the requirements cite `2025-11-25`.
- **Severity:** Medium
- **Workaround:** Support both; contract tests initialize with each.
- **Suggestion:** Update the sample, or state which versions Alexa+ sends and accepts.

### MCP Toolkit, CLI and Web Simulator are partner-only
- **Task attempted:** Test the add-on against Alexa+.
- **Steps taken:** Followed the setup guides.
- **Expected:** Setup guides that say up front whether entrants can use the tools.
- **Actual:** Only the docs home page and the hackathon FAQ say the tools are for select partners.
- **Severity:** High
- **Workaround:** Built our own simulator that follows Alexa's rules (401 → PRM → AS metadata → PKCE with resource → retry).
- **Suggestion:** Note the restriction in every setup guide, or give hackathon entrants sandbox access.

### No documented proactive notifications for MCP add-ons
- **Task attempted:** Tell family members when a check-in is missed.
- **Steps taken:** Searched the Alexa+ add-on docs for push or proactive events.
- **Expected:** A way for an add-on to notify a linked customer.
- **Actual:** None documented.
- **Severity:** High
- **Workaround:** Email from our own backend (EventBridge sweep → SQS → SES).
- **Suggestion:** Proactive notifications for MCP add-ons, with consent.

### Elicitation described but not declared by the sample client
- **Task attempted:** Ask for missing input mid-tool.
- **Steps taken:** Read the lifecycle page, then the sample handshake.
- **Expected:** `elicitation` in the client capabilities if it's supported.
- **Actual:** The sample handshake declares only `roots`.
- **Severity:** Low
- **Workaround:** Ask for missing input in the reply text.
- **Suggestion:** Declare elicitation in the handshake or say it's unsupported.

### MCP SDK v2's stateless fallback streams SSE for 2025-era clients
- **Task attempted:** Serve 2025-03-26 and 2025-11-25 clients statelessly with plain JSON responses.
- **Steps taken:** `createMcpHandler(factory)` with default `legacy: 'stateless'`; probed with both versions.
- **Expected:** An option for JSON responses on the legacy path (`responseMode` applies only to 2026-07-28 traffic).
- **Actual:** Responses are `text/event-stream`.
- **Severity:** Medium
- **Workaround:** Route with `isLegacyRequest` to our own `WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })`.
- **Suggestion:** Let `responseMode: 'json'` also apply to the stateless legacy fallback.

### SDK input-validation errors aren't speakable
- **Task attempted:** Return a voice-friendly message when a note is over 140 characters.
- **Steps taken:** Registered tools with zod input schemas.
- **Expected:** A hook to customize the validation error text.
- **Actual:** The tool result says "Input validation error: Invalid arguments for tool check_in: note: Too big…", which a voice assistant would read aloud.
- **Severity:** Medium
- **Workaround:** Publish the schema but validate inside the tool (`publishedSchema` wrapper).
- **Suggestion:** An `onInputValidationError` callback on `registerTool`.

### DynamoDB reserved word `sub`
- **Task attempted:** Update a user profile item.
- **Steps taken:** `UpdateExpression: 'SET sub = :sub'`.
- **Expected:** Works, or a lint-time warning.
- **Actual:** Runtime `ValidationException: Attribute name is a reserved keyword; reserved keyword: sub`.
- **Severity:** Low
- **Workaround:** `#sub` with `ExpressionAttributeNames`.
- **Suggestion:** A reserved-word check in `lib-dynamodb` builders or the SDK docs examples.

### Cognito access tokens don't carry email or name
- **Task attempted:** Know a caregiver's email (for alerts) and first name from the access token the API receives.
- **Steps taken:** Read the Cognito access-token claims.
- **Expected:** A way to include `email` / `given_name` in access tokens for resource servers.
- **Actual:** Only ID tokens carry them by default; adding claims to access tokens needs a V2 pre-token-generation trigger, which needs the Essentials feature plan.
- **Severity:** Medium
- **Workaround:** V2 pre-token trigger in `infra/lambda/pre-token.ts`; the dev issuer includes the claims directly.
- **Suggestion:** Allow mapping standard attributes into access tokens without a Lambda.

### Lambda Web Adapter + `NodejsFunction` handler
- **Task attempted:** Run our Node HTTP server in Lambda with the Web Adapter, bundled by CDK's `NodejsFunction`.
- **Steps taken:** Set `handler: 'run.sh'`.
- **Expected:** The handler used as-is.
- **Actual:** `NodejsFunction` always writes `index.<handler>`.
- **Severity:** Low
- **Workaround:** Override `CfnFunction.handler` and write `run.sh` in an `afterBundling` hook.
- **Suggestion:** A Web Adapter option on `NodejsFunction`, or a documented CDK pattern.

### MCP Inspector CLI can't take a bearer token non-interactively for OAuth-protected tools
- **Task attempted:** Call a protected tool from CI with the Inspector CLI.
- **Steps taken:** `--cli <url> --method tools/call --tool-name check_in`.
- **Expected:** A way to pass a pre-minted bearer token, or the 401 surfaced as a result.
- **Actual:** `auth_required: Interactive OAuth requires a TTY …`.
- **Severity:** Low
- **Workaround:** Our own contract tests cover protected tools; the Inspector covers public methods, schemas and MCP App metadata.
- **Suggestion:** Document `--header "Authorization: Bearer …"` behavior next to `--stored-auth-only`.

### Paths with spaces break CDK entry paths built from `URL.pathname`
- **Task attempted:** Point `NodejsFunction.entry` at a file relative to the stack module.
- **Steps taken:** `new URL('../lambda/x.ts', import.meta.url).pathname`.
- **Expected:** A usable path.
- **Actual:** `CannotFindEntryFile` because the space is URL-encoded (`%20`).
- **Severity:** Low
- **Workaround:** `fileURLToPath`.
- **Suggestion:** CDK examples for ESM projects should use `fileURLToPath`.

### Bedrock Converse returns "Operation not allowed" on a new account
- **Task attempted:** Run the simulator's Bedrock agent on Claude Haiku 5.5 (`us.anthropic.claude-haiku-5-5`) in us-east-1.
- **Steps taken:** `aws bedrock-runtime converse` as an admin IAM user; also tried Amazon Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`).
- **Expected:** A reply, or a clear message naming the missing step.
- **Actual:** `ValidationException: Operation not allowed` for both models. `get-use-case-for-model-access` says the Anthropic form isn't filled; `get-foundation-model-availability` shows `NOT_AUTHORIZED`. Nova failing too points to an account-level block on a new account. Submitting the Anthropic use-case form in the console then failed with "Your account is not authorized to perform this action. Please create a support case", which confirms it.
- **Severity:** Medium (blocks the Bedrock agent; the scripted agent still works)
- **Workaround:** Use the scripted agent; submit the Anthropic use-case form; open a support case if Nova still fails.
- **Suggestion:** Return an error that says which step is missing (use-case form vs. account quota) instead of a generic "Operation not allowed".

### Cognito session cookie survives app sign-out; classic hosted UI ignores `prompt=login`
- **Task attempted:** Sign up three test users on the dashboard, signing out between them; link three personas in the simulator.
- **Steps taken:** Dashboard sign-out cleared its own tokens; clicked Sign in again.
- **Expected:** The Cognito sign-in page.
- **Actual:** Cognito's session cookie signed the previous user straight back in. `prompt=login` would force a fresh login, but it only works with the newer managed login pages, not the classic hosted UI. In the simulator this would silently link one persona as another user.
- **Severity:** Medium (wrong-account linking is a privacy risk in a family app)
- **Workaround:** Register sign-out URLs on the app clients; the dashboard's Sign out goes through Cognito `/logout`, and each simulator link goes `/logout` → `/link/resume` → `/oauth2/authorize`.
- **Suggestion:** Support `prompt=login` on the classic hosted UI too, or document the session cookie next to the authorize endpoint.

### Strands `FunctionTool` turns every thrown error into a tool result
- **Task attempted:** Start Alexa-style account linking when a Care Circle tool returns 401 inside a Strands agent.
- **Steps taken:** Threw our `NeedsLinking` error from the tool callback.
- **Expected:** A way to stop the agent loop with that error (or to rethrow chosen error types).
- **Actual:** `FunctionTool` catches it and hands the model an error result; the model then apologizes, and our code never sees the 401.
- **Severity:** Medium
- **Workaround:** Set a flag in the callback, call `agent.cancel()`, and raise `NeedsLinking` after `invoke` returns `stopReason: 'cancelled'`.
- **Suggestion:** An option on `FunctionTool` (or a hook) to let selected error types propagate out of `invoke`.

### Small local model skips tools for emergencies and invents actions
- **Task attempted:** Drive Care Circle with Qwen 3 8B through Strands (LM Studio).
- **Steps taken:** Ran the 20-phrase crisis suite and loose everyday phrasings.
- **Expected:** "I have chest pain" → `check_in` (Care Circle says 911 first and emails the family).
- **Actual:** 12 of 20 crisis phrases were answered by the model itself without calling a tool. "Ugh, rough night, but I'm up" got "I'll let your family know you're up" with no tool call.
- **Severity:** High for safety, if not handled
- **Workaround:** Deterministic crisis matcher before the model; prompt rules ("never claim an action no tool did"); a loose-phrasing test set gating at ≥ 90%.
- **Suggestion:** Agent frameworks could offer a "required tool for these intents" guard. Alexa+ guidance for add-ons should say how crisis wording is routed.

### CloudShell unavailable on a new account ("verification in progress")
- **Task attempted:** Measure Care Circle's latency from inside us-east-1, as Alexa would see it, using AWS CloudShell.
- **Steps taken:** Opened CloudShell in us-east-1 as an IAM admin user.
- **Expected:** A shell.
- **Actual:** "Unable to create the environment. Your account verification is in progress. This may take up to two days for new accounts." The same hold blocks Bedrock, while Lambda, API Gateway, DynamoDB, Cognito, SES and CDK deploys all work.
- **Severity:** Low (we use API Gateway's own CloudWatch latency metrics instead)
- **Workaround:** Generate load from a laptop and read API Gateway `Latency`/`IntegrationLatency` and Lambda `Duration` percentiles for that window.
- **Suggestion:** Show "account verification pending" once, in one place (Billing or the console home), with which services it blocks. Today it surfaces as unrelated errors in Bedrock ("Operation not allowed") and CloudShell.
