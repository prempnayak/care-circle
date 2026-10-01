import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { type CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { nodeFunction, repoRoot, WEB_ADAPTER_ENV, webAdapterLayer } from './bundling';

export interface WebStackProps extends StackProps {
  mcpUrl: string;
  bedrockModelId: string;
  simulatorClientId: string;
  simulatorUrl: string;
  lwaLayerVersion: number;
  demo: boolean;
  devKey?: Secret;
}

/**
 * S3 + CloudFront for the dashboard and the simulator front end, and the simulator agent backend
 * (same Hono app as locally, behind the Web Adapter) with bedrock:InvokeModel for one model only.
 * Front-end builds read VITE_* URLs at build time, so build them after the API URL is known.
 */
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    for (const [name, dir] of [
      ['Dashboard', 'apps/dashboard/dist'],
      ['Simulator', 'apps/simulator/dist'],
    ] as const) {
      const bucket = new Bucket(this, `${name}Bucket`, {
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        encryption: BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      });
      const dist = new Distribution(this, `${name}Cdn`, {
        defaultBehavior: { origin: S3BucketOrigin.withOriginAccessControl(bucket), viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS },
        defaultRootObject: 'index.html',
        // SPA: serve index.html for client routes such as /callback.
        errorResponses: [
          { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
          { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
        ],
      });
      const built = `${repoRoot}${dir}`;
      if (existsSync(built)) {
        new BucketDeployment(this, `${name}Deploy`, { sources: [Source.asset(built)], destinationBucket: bucket, distribution: dist });
      }
      new CfnOutput(this, `${name}Url`, { value: `https://${dist.distributionDomainName}` });
    }

    const agent = nodeFunction(this, 'SimulatorAgent', {
      entry: `${repoRoot}apps/simulator/server/main.ts`,
      memorySize: 1024,
      timeout: Duration.seconds(29),
      layers: [webAdapterLayer(this, props.lwaLayerVersion)],
      environment: {
        ...WEB_ADAPTER_ENV,
        SIM_AGENT_PORT: '8080',
        MCP_URL: props.mcpUrl || 'https://example.invalid/mcp',
        SIM_AGENT: props.bedrockModelId ? 'bedrock' : 'scripted',
        BEDROCK_MODEL_ID: props.bedrockModelId,
        SIM_CLIENT_ID: props.simulatorClientId,
        SIMULATOR_URL: props.simulatorUrl,
        SIM_TOKEN_FILE: '/tmp/tokens.json',
        SKILL_PATH: '/var/task/SKILL.md',
        ...(props.demo && props.devKey ? { DEV_ENDPOINTS: 'true', DEV_KEY: props.devKey.secretValue.unsafeUnwrap() } : {}),
      },
      bundling: {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp "${inputDir}/skills/care-circle/SKILL.md" "${outputDir}/SKILL.md"`,
            `printf '#!/bin/sh\\nexec node /var/task/index.mjs\\n' > "${outputDir}/run.sh"`,
            `chmod +x "${outputDir}/run.sh"`,
          ],
        },
      },
    });
    (agent.node.defaultChild as CfnFunction).handler = 'run.sh';
    if (props.bedrockModelId) {
      // The model itself, plus (for a cross-region inference profile like "us.<model>") the profile and
      // the same base model in the regions it routes to. Nothing else.
      const baseModel = props.bedrockModelId.replace(/^(us|eu|apac|global)\./, '');
      agent.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:InvokeModel'],
          resources: [
            `arn:aws:bedrock:${this.region}::foundation-model/${props.bedrockModelId}`,
            `arn:aws:bedrock:*:${this.account}:inference-profile/${props.bedrockModelId}`,
            `arn:aws:bedrock:*::foundation-model/${baseModel}`,
          ],
        }),
      );
    }
    const agentApi = new HttpApi(this, 'SimulatorAgentApi', { defaultIntegration: new HttpLambdaIntegration('AgentIntegration', agent) });
    new CfnOutput(this, 'SimulatorAgentUrl', { value: agentApi.apiEndpoint });
  }
}
