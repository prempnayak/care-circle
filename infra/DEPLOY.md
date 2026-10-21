# Deploying Care Circle to AWS — step by step

What gets deployed: **Data** (DynamoDB + KMS), **Auth** (Cognito), **Workers** (SQS, notifier, scheduler, SES) and **Api** (the MCP server in Lambda behind API Gateway). The dashboard and simulator **UIs run on your laptop** and talk to the cloud API. Their sign-in redirects go to `localhost`, which Cognito allows. (The `CareCircleWeb` stack is optional and not needed for the demo.)

Region: `us-east-1`. Time: ~45 minutes, most of it waiting. Cost for a few days of testing: small (KMS key ~$1/month prorated; Lambda, API Gateway, DynamoDB, SQS, SES and Scheduler at demo volume are cents). Check Cognito Essentials pricing for your user count on the Cognito pricing page. **Set the budget alarm in step 1.2 anyway.**

All commands run from the repository root unless noted.

---

## 1. One-time AWS setup

**1.1 Credits.** Request the hackathon AWS credits (form closes **Oct 21, 12:00 pm PT**).

**1.2 Budget alarm.** AWS console → Billing and Cost Management → Budgets → Create budget → *Monthly cost budget* → $10 → your email. Takes 2 minutes and protects you from surprises.

**1.3 A non-root identity with admin rights.** Don't use the root user.
- Console → IAM → Users → Create user (e.g. `care-circle-admin`) → *Provide user access to the AWS Management Console* → attach the `AdministratorAccess` policy.
- Sign in to the console as that user once.

**1.4 CLI credentials** (AWS CLI v2.37 is already installed on this Mac):
```bash
aws login                                  # opens the browser; sign in as care-circle-admin
aws configure set region us-east-1
aws sts get-caller-identity                # must print your account id and the user ARN
```
(If `aws login` isn't available on your account, use `aws configure` with an access key for that user.)

**1.5 Pick values** (keep this terminal open; every later command uses them):
```bash
export CC_PREFIX=care-circle-<yourname>-<4 random letters>   # Cognito domain prefix: lowercase, globally unique, no "aws"/"amazon"/"cognito"
export CC_MAIL=<an email you can open>                       # sender address for alert emails (SES)
export AWS_REGION=us-east-1
```

**1.6 Three test emails you can open**, one each for Margaret, Sarah and Tom. Gmail "plus" addresses work and land in one inbox: `you+margaret@gmail.com`, `you+sarah@gmail.com`, `you+tom@gmail.com`.

---

## 2. Build and bootstrap

```bash
npm ci
npm run build                      # builds the card (bundled into the API Lambda) and the UIs
npm run cdk -- bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1
```
Bootstrap is once per account/region. It creates the CDK staging bucket and roles.

---

## 3. First deploy

```bash
npm run cdk -- deploy CareCircleData CareCircleAuth CareCircleWorkers CareCircleApi \
  -c cognitoDomainPrefix=$CC_PREFIX \
  -c mailFrom=$CC_MAIL \
  -c dashboardUrl=http://localhost:5173 \
  -c simulatorUrl=http://localhost:5174 \
  -c simAgentUrl=http://localhost:8790 \
  --outputs-file cdk-outputs.json
```
- Answer **y** when CDK asks to approve IAM changes.
- It takes ~10–15 minutes. Outputs are written to `infra/cdk-outputs.json` (gitignored).
- You'll see a warning that `publicBaseUrl` is empty. That's expected; step 4 fixes it.

Load the outputs into the shell:
```bash
out() { node -e "const o=require('./infra/cdk-outputs.json');console.log(o['$1']['$2'])"; }
export CC_API=$(out CareCircleApi ApiUrl)                 # e.g. https://abc123.execute-api.us-east-1.amazonaws.com
export CC_POOL=$(out CareCircleAuth UserPoolId)
export CC_SIM_CLIENT=$(out CareCircleAuth SimulatorClientId)
export CC_DASH_CLIENT=$(out CareCircleAuth DashboardClientId)
export CC_KEY=$(out CareCircleData DataKeyArn)
echo $CC_API
```

---

## 4. Second deploy (tell the API its own URL)

The Protected Resource Metadata, the RFC 8414 issuer and the token audience all need the API's public URL, which only exists after step 3. Run the same command with one more `-c`:

```bash
npm run cdk -- deploy CareCircleApi \
  -c cognitoDomainPrefix=$CC_PREFIX -c mailFrom=$CC_MAIL \
  -c dashboardUrl=http://localhost:5173 -c simulatorUrl=http://localhost:5174 -c simAgentUrl=http://localhost:8790 \
  -c publicBaseUrl=$CC_API \
  --outputs-file cdk-outputs.json
```
**Keep every `-c` value identical on every later deploy** (or put them in `infra/cdk.json` → `context`).

---

## 5. Verify the email sender (SES sandbox)

- AWS emails `$CC_MAIL` a verification link: open it and click it.
- In the SES sandbox, **recipients must be verified too**. Verify Sarah's and Tom's test addresses (Margaret doesn't receive alerts):
  ```bash
  aws sesv2 create-email-identity --email-identity you+sarah@gmail.com
  aws sesv2 create-email-identity --email-identity you+tom@gmail.com
  ```
  Then click both verification links.
- Check: `aws sesv2 list-email-identities` shows `"VerificationStatus": "SUCCESS"` for all three.

---

## 6. Smoke-test the cloud API

```bash
curl -s $CC_API/healthz                                            # {"ok":true}
curl -s $CC_API/.well-known/oauth-protected-resource               # resource = $CC_API/mcp, authorization_servers = [$CC_API]
curl -s $CC_API/.well-known/oauth-authorization-server             # Cognito endpoints, "S256"
curl -s -i -X POST $CC_API/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_in","arguments":{}}}' | head -12
                                                                   # HTTP/2 401 and NO www-authenticate header
MCP_URL=$CC_API/mcp npm run test:inspector                         # 4/4 ✓
```
The first request after a deploy or idle period is a Lambda cold start (a second or two). Warm the API before recording.

---

## 7. Run the UIs on your laptop against the cloud

Three terminals, each with the `export`s from steps 1.5 and 3:

```bash
# A: simulator agent (the Alexa+ stand-in backend)
MCP_URL=$CC_API/mcp SIM_CLIENT_ID=$CC_SIM_CLIENT DEV_ENDPOINTS=false SIM_TOKEN_FILE=/tmp/cc-cloud-tokens.json \
  npm -w @care-circle/simulator run dev:agent

# B: simulator UI → http://localhost:5174
npm -w @care-circle/simulator run dev:ui

# C: dashboard → http://localhost:5173
VITE_API_URL=$CC_API VITE_AUTH_ISSUER=$CC_API VITE_DASHBOARD_CLIENT_ID=$CC_DASH_CLIENT \
  npm -w @care-circle/dashboard run dev
```
(Local DynamoDB and dev-auth aren't used in this mode.)

---

## 8. Create the people and the circle

Pick **one** of the following.

### 8A. Live setup (records J1 for real)
1. **Dashboard** → *Sign in* → Cognito page → *Sign up* as Sarah (`you+sarah@…`, given name "Sarah") → enter the emailed code → you're back on the dashboard.
2. *Create a circle* for Margaret (`America/New_York`, 07:00–10:00, grace 30) → **Medicines**: metformin 08:00 (nickname "diabetes pill"), lisinopril 09:00 ("blood pressure pill") → **Family** → *Code for Margaret* (write it down) and *Code for a family member*.
3. **Simulator** → persona *Margaret* → "Alexa, tell Care Circle my code is ######" → 401 → **Link account** → in the popup *Sign up* as Margaret (`you+margaret@…`, given name "Margaret") → back in the simulator the call retries → read-back → say "yes".
4. Persona *Tom* → same with the family-member code → sign up as Tom.

### 8B. Seeded history (14 days, matches the local demo)
1. Sign up the three users **without creating a circle**: dashboard → *Sign in* → *Sign up* as Margaret, then sign out; repeat for Sarah and Tom.
2. Seed:
   ```bash
   TABLE_NAME=CareCircle KMS_KEY_ID=$CC_KEY COGNITO_USER_POOL_ID=$CC_POOL \
     npm run seed:cloud -- --margaret you+margaret@gmail.com --sarah you+sarah@gmail.com --tom you+tom@gmail.com
   ```
3. Link Margaret, Sarah and Tom in the simulator (the link popup now just signs in).

---

## 9. Walk the journeys in the cloud

- **J2–J4, J6:** same phrases as locally (simulator suggestions). The trace panel shows the real API Gateway URL and latencies.
- **J5 without a clock jump:** the cloud uses real time. On the dashboard → **Check-in window**, set *Until* to ~5 minutes from now (New York time) and *Minutes to wait* to **0**. Don't check in as Margaret. Within ~5 minutes of that time the sweep (every 5 min) emails Sarah and Tom. Then check in as Margaret → the "all clear" email. Set the window back afterwards.

---

## 10. Cloud latency numbers (for the README)

```bash
TOK() { node -e "console.log(require('/tmp/cc-cloud-tokens.json')['$1'].accessToken)"; }
TARGET_URL=$CC_API/mcp TOKEN_RECIPIENT=$(TOK margaret) TOKEN_CAREGIVER=$(TOK sarah) N=100 CONCURRENCY=10 npm run test:latency
# Full gate (20 VUs, 2 min):  brew install k6, then
TARGET_URL=$CC_API/mcp TOKEN_RECIPIENT=$(TOK margaret) TOKEN_CAREGIVER=$(TOK sarah) npm run test:load
```
Tokens last 1 hour; re-link in the simulator if they expire.

---

## 11. If account linking fails at Cognito (option b)

Cognito documents support for the `resource` parameter on `/oauth2/authorize` ("resource binding", RFC 8707). If the popup still shows a Cognito error about `resource`, or the token exchange fails in the trace panel, switch to our proxy, which strips `resource` before it reaches Cognito:
```bash
npm run cdk -- deploy CareCircleApi <same -c values as step 4> -c oauthProxy=true --outputs-file cdk-outputs.json
```
Record which option worked in `docs/decisions.md` and `docs/friction-log.md`.

---

## 12. Tear down when you're done recording

```bash
npm run cdk -- destroy --all \
  -c cognitoDomainPrefix=$CC_PREFIX -c mailFrom=$CC_MAIL -c publicBaseUrl=$CC_API \
  -c dashboardUrl=http://localhost:5173 -c simulatorUrl=http://localhost:5174 -c simAgentUrl=http://localhost:8790
```
- This deletes the table and user pool (and their data).
- The KMS key is scheduled for deletion (pending window) rather than removed at once.
- Lambda log groups in CloudWatch remain. Delete them in the console if you like.
- Check Billing → Bills the next day.

## Not needed for the demo

- `-c demo=true`: turns on `/dev/*` in the cloud and provisioned concurrency 2 (extra cost). The cloud demo uses real time instead (step 9).
- `CareCircleWeb`: hosting the UIs on CloudFront. Possible later; the simulator agent keeps linking state in memory, so it needs a single instance or a shared store before it works reliably in Lambda.
- Bedrock: separate approval; `SIM_AGENT=bedrock BEDROCK_MODEL_ID=… ` on terminal A plus model access in the Bedrock console.
