# Product feedback

> Status Oct 22: everything below was used for real. The AWS stacks were deployed to us-east-1 on Oct 20 and the journeys were walked end to end in the cloud (account linking, check-ins, doses, messages, crisis redirect, missed check-in/medicine emails and the all-clear). Bedrock is the exception: the account is blocked from model invocation (see the friction log).

### MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `/client`)
- **Used for:** the MCP server (`McpServer`, `createMcpHandler`, `WebStandardStreamableHTTPServerTransport`, `isLegacyRequest`) and the simulator/test client (`Client`, `StreamableHTTPClientTransport`).
- **Worked well:** web-standard `Request`/`Response` made Hono integration trivial; per-request factories fit a stateless server; Standard Schema support meant our zod schemas published cleanly; good type docs in the `.d.mts`.
- **Needs work:** the stateless legacy fallback always answers with SSE (no JSON option); input-validation errors aren't customizable (they'd be spoken to users); the v1 → v2 package split isn't obvious from older guides.
- **Onboarding:** fast once we read the types; the serving guide is clear.
- **Again?** Yes: it's the reference implementation and the era-routing is well thought out.

### MCP Apps (`@modelcontextprotocol/ext-apps`)
- **Used for:** `registerAppTool` / `registerAppResource` on the server, `App` in the card, and `AppBridge` + `PostMessageTransport` to host the card in the simulator.
- **Worked well:** host and view helpers in one package; the `sendToolInput` → `sendToolResult` order is documented in the types.
- **Needs work:** the single-file card is ~237 KB because the view helper bundles zod; a lighter view-only entry would help.
- **Onboarding:** good; the shipped Agent Skills and examples are useful.
- **Again?** Yes.

### MCP Inspector (CLI mode)
- **Used for:** `tools/list --strict`, `--app-info`, `resources/read`, unauthenticated tool calls (`npm run test:inspector`).
- **Worked well:** `--strict` schema portability checks and `--app-info` are excellent for CI.
- **Needs work:** OAuth in CLI mode needs a TTY (a header-only bearer mode for CI would help).
- **Again?** Yes.

### Amazon Alexa+ MCP add-on docs
- **Used for:** transport, auth discovery (401 without `WWW-Authenticate`, PRM, RFC 8414), lifecycle, functional and policy requirements.
- **Worked well:** the auth discovery rules are precise and testable.
- **Needs work:** the sample `initialize` uses `2025-03-26` while requirements cite `2025-11-25`; partner-only tools aren't flagged in the setup guides; no proactive-notification story.
- **Again?** Yes, with the developer tools.

### AWS Lambda + AWS Lambda Web Adapter
- **Used for:** running the same Node HTTP server in Lambda (API and simulator agent).
- **Worked well:** zero code changes between local and cloud. Measured inside API Gateway (warm, 5 tools): p50 36 ms, p95 62 ms, p99 85 ms one at a time; p95 65 ms at 10 at a time.
- **Needs work (measured):** cold starts add 0.5–2 s; ten concurrent requests start ten environments, which shows up in p99. Provisioned concurrency fixes it at a cost.
- **Needs work:** `NodejsFunction` always sets `index.<handler>`, so pointing the handler at `run.sh` needs an escape hatch.
- **Again?** Yes.

### Amazon API Gateway (HTTP API)
- **Used for:** the public HTTPS front door for the API and the simulator agent.
- **Worked well:** simple default route to a Lambda alias; the built-in `Latency` / `IntegrationLatency` percentiles in CloudWatch gave us server-side numbers without extra tooling.
- **Needs work:** the URL isn't known until after the first deploy, which makes PRM/issuer URLs a two-step deploy without a custom domain.
- **Again?** Yes.

### Amazon DynamoDB (and DynamoDB Local)
- **Used for:** the single table, GSIs for identity and deadlines, TTL, conditional writes for idempotency, transactions.
- **Worked well:** conditional updates made the sweep and alerts idempotent; DynamoDB Local made tests realistic.
- **Needs work:** reserved words like `sub` only fail at runtime.
- **Again?** Yes.

### Amazon Cognito
- **Used for:** user pool, managed login, resource server + custom scope, static app clients.
- **Worked well:** the CDK L2 constructs cover the resource server, scopes, V2 triggers and feature plans.
- **Worked well (verified):** `resource` (RFC 8707) is accepted on `/oauth2/authorize` and at the token endpoint, so Alexa-style linking goes straight to Cognito with no proxy.
- **Needs work:** RFC 8414 metadata isn't served (only OIDC discovery), so we host a facade; access tokens lack email unless you use the Essentials plan and a pre-token trigger; the session cookie outlives an app's own sign-out and `prompt=login` only works with the newer managed login pages, so we route sign-out and each account link through `/logout`.
- **Again?** Yes, with the facade.

### AWS KMS
- **Used for:** the table CMK and field-level encryption with an encryption context per circle.
- **Worked well:** encryption context makes cross-circle misuse visible in CloudTrail.
- **Again?** Yes.

### Amazon EventBridge Scheduler
- **Used for:** the 5-minute sweep and hourly materializer.
- **Worked well:** the CDK L2 `Schedule` + `LambdaInvoke` is concise; the 5-minute sweep sent the missed check-in and missed medicine emails on schedule in the cloud.
- **Again?** Yes.

### Amazon SQS
- **Used for:** the alert queue with a DLQ and partial batch responses.
- **Worked well:** `reportBatchItemFailures` keeps one bad message from retrying the batch.
- **Again?** Yes.

### Amazon SES
- **Used for:** family alert emails.
- **Worked well:** alert, crisis, message and all-clear emails arrived within seconds.
- **Needs work:** the sandbox requires verifying every recipient, which slows family-style demos.
- **Again?** Yes.

### Amazon Bedrock (Converse API) (blocked on this account)
- **Used for:** the simulator's agent: Agent Skill as system prompt, MCP tools as tool specs, ≤ 4 tool calls per turn.
- **Worked well (from the SDK types):** tool-use stop reasons and tool result blocks map cleanly onto MCP results.
- **Needs work:** inference-profile ARNs make least-privilege IAM fiddly. On a new account every model (Claude and Amazon Nova) returned a generic `Operation not allowed`, and the Anthropic use-case form itself was refused until a support case; the simulator uses its scripted agent meanwhile.
- **Again?** Yes.

### Strands Agents SDK (TypeScript, v1.22)
- **Used for:** the simulator's Alexa+ stand-in, with Care Circle's MCP tools as `FunctionTool`s and the Agent Skill as the system prompt. The model is LM Studio (OpenAI-compatible, Qwen 3 8B) or Bedrock, chosen by a setting.
- **Worked well:** switching providers is one constructor (`OpenAIModel` with `api: 'chat'` and a `baseURL`, or `BedrockModel`). It ships an MCP client on the same MCP SDK v2 we use. `agent.cancel()` and `stopReason: 'cancelled'` gave a clean "one tool per turn" loop. Tool calling against a local OpenAI-compatible server worked first time.
- **Needs work:** `FunctionTool` swallows thrown errors (see the friction log). `printer` defaults to true, which is noisy in a server. The OpenAI provider defaults to the Responses API, which many local servers don't offer; it's easy to miss `api: 'chat'`.
- **Again?** Yes.

### AWS CDK v2
- **Used for:** all stacks.
- **Worked well:** `NodejsFunction` bundling with local esbuild; synth runs without credentials.
- **Needs work:** paths with spaces break `new URL(...).pathname` entry paths (use `fileURLToPath`).
- **Again?** Yes.
