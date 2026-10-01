/**
 * Care Circle on AWS. `npm run cdk -- synth` is safe; NEVER `cdk deploy` without the human's approval
 * (it creates billable resources). See infra/README.md for the two-step deploy and context values.
 */
import { App, Tags } from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
import { DataStack } from '../lib/data-stack';
import { WebStack } from '../lib/web-stack';
import { WorkersStack } from '../lib/workers-stack';

const app = new App();
const ctx = (key: string) => app.node.tryGetContext(key);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' };
const demo = ctx('demo') === true || ctx('demo') === 'true';

const data = new DataStack(app, 'CareCircleData', { env });
const auth = new AuthStack(app, 'CareCircleAuth', {
  env,
  domainPrefix: ctx('cognitoDomainPrefix'),
  alexaRedirectUris: ctx('alexaRedirectUris') ?? [],
  dashboardUrl: ctx('dashboardUrl') || 'http://localhost:5173',
  simAgentUrl: ctx('simAgentUrl') || 'http://localhost:8790',
});
const workers = new WorkersStack(app, 'CareCircleWorkers', {
  env,
  table: data.table,
  key: data.key,
  mailFrom: ctx('mailFrom'),
  dashboardUrl: ctx('dashboardUrl') || 'http://localhost:5173',
});
const api = new ApiStack(app, 'CareCircleApi', {
  env,
  demo,
  table: data.table,
  key: data.key,
  queue: workers.queue,
  userPool: auth.userPool,
  clientIds: auth.clientIds,
  cognitoDomain: auth.cognitoDomain,
  publicBaseUrl: ctx('publicBaseUrl') || '',
  corsOrigins: [ctx('dashboardUrl'), ctx('simulatorUrl')].filter(Boolean),
  lwaLayerVersion: Number(ctx('lwaLayerVersion') ?? 30),
  oauthProxy: ctx('oauthProxy') === true || ctx('oauthProxy') === 'true',
});
new WebStack(app, 'CareCircleWeb', {
  env,
  mcpUrl: ctx('publicBaseUrl') ? `${String(ctx('publicBaseUrl')).replace(/\/$/, '')}/mcp` : '',
  bedrockModelId: ctx('bedrockModelId') || '',
  simulatorClientId: auth.simulatorClientId,
  simulatorUrl: ctx('simulatorUrl') || '',
  lwaLayerVersion: Number(ctx('lwaLayerVersion') ?? 30),
  demo,
  devKey: api.devKey,
});

Tags.of(app).add('project', 'care-circle');
