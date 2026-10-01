# Care Circle on AWS (CDK)

> **Ask the human before any `cdk deploy`.** It creates billable resources (Cognito Essentials, Lambda,
> API Gateway, DynamoDB, KMS, SQS, SES, CloudFront, EventBridge Scheduler, Secrets Manager in demo mode).
> After recording, run `npm run cdk -- destroy --all`.

## Stacks

| Stack | Contents |
| --- | --- |
| `CareCircleData` | DynamoDB `CareCircle` (on demand, PITR, TTL `expiresAt`, GSI1, GSI2), KMS customer-managed key (rotation on) |
| `CareCircleAuth` | Cognito user pool (Essentials plan, for the pre-token trigger), managed login domain, resource server `carecircle` + scope `circle`, app clients `alexa` (confidential), `simulator`, `dashboard` (public), V2 pre-token trigger adding `email` and `given_name` to access tokens |
| `CareCircleWorkers` | SQS alert queue + DLQ (3 attempts), notifier Lambda, materializer (hourly) and sweep (5 min) on EventBridge Scheduler, SES sender identity |
| `CareCircleApi` | The same Node server as local mode, in Lambda (arm64, 1024 MB) via the AWS Lambda Web Adapter layer (v30), behind an API Gateway HTTP API; alias `live` with provisioned concurrency **only** with `-c demo=true` (2) |
| `CareCircleWeb` | S3 + CloudFront for the dashboard and simulator front ends; the simulator agent Lambda with `bedrock:InvokeModel` for `bedrockModelId` only |

## Commands

```bash
npm run build                      # builds the card (bundled into the API) and both front ends
npm run cdk -- synth               # safe: no AWS calls beyond context lookups
npm run cdk -- diff                # needs credentials; read-only
# with approval only:
npm run cdk -- deploy --all
```

## Two-step deploy (URLs aren't known until the first deploy)

1. `npm run cdk -- deploy --all` → note `ApiUrl`, `DashboardUrl`, `SimulatorUrl`, `SimulatorAgentUrl`.
2. Redeploy with the URLs as context so the Protected Resource Metadata, the token audience, CORS and the OAuth redirect URIs line up:
   ```bash
   npm run cdk -- deploy --all \
     -c publicBaseUrl=<ApiUrl> -c dashboardUrl=<DashboardUrl> -c simulatorUrl=<SimulatorUrl> -c simAgentUrl=<SimulatorAgentUrl>
   ```
3. Rebuild the front ends with `VITE_API_URL`, `VITE_AUTH_ISSUER=<ApiUrl>`, `VITE_DASHBOARD_CLIENT_ID`, `VITE_AGENT_URL` and deploy again (the Web stack uploads `apps/*/dist`).

Other context: `-c demo=true` (dev endpoints + provisioned concurrency 2), `-c bedrockModelId=…` (human picks; needs model access),
`-c mailFrom=…` (verify in SES; in the SES sandbox every recipient must be verified), `-c alexaRedirectUris='["…"]'` (from the Alexa console),
`-c oauthProxy=true` (option b, if Cognito rejects the `resource` parameter — Phase 0 spike).

## Human tasks

- Approve deploys and Bedrock model access; request AWS credits by Oct 21.
- Verify the SES sender (and test recipients while in the sandbox).
- Add Alexa's redirect URIs to the `alexa` client once the Alexa console is available.
