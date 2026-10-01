import { Annotations, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { UserPool } from 'aws-cdk-lib/aws-cognito';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import type { Key } from 'aws-cdk-lib/aws-kms';
import { Alias, type CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { nodeFunction, repoRoot, WEB_ADAPTER_ENV, webAdapterLayer } from './bundling';

export interface ApiStackProps extends StackProps {
  demo: boolean;
  table: Table;
  key: Key;
  queue: Queue;
  userPool: UserPool;
  clientIds: string[];
  cognitoDomain: string;
  /** The API's public URL (custom domain, or the HttpApi URL from a first deploy). */
  publicBaseUrl: string;
  corsOrigins: string[];
  lwaLayerVersion: number;
  oauthProxy: boolean;
}

/**
 * The same Node server that runs locally, in Lambda through the AWS Lambda Web Adapter, behind an
 * API Gateway HTTP API. Provisioned concurrency is 0 by default and 2 only with `-c demo=true`.
 * Dev endpoints (/dev/*) are off unless the `demo` context is set.
 */
export class ApiStack extends Stack {
  readonly devKey?: Secret;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const publicBaseUrl = props.publicBaseUrl || 'https://example.invalid';
    if (!props.publicBaseUrl) {
      Annotations.of(this).addWarning(
        'publicBaseUrl context is empty: deploy once, then redeploy with -c publicBaseUrl=<ApiUrl output> so PRM and token audience match.',
      );
    }

    if (props.demo) {
      this.devKey = new Secret(this, 'DevKey', {
        description: 'X-Dev-Key for the Care Circle demo controls (demo context only)',
        generateSecretString: { passwordLength: 32, excludePunctuation: true },
      });
    }

    const fn = nodeFunction(this, 'Api', {
      entry: `${repoRoot}packages/mcp-server/src/main.ts`,
      memorySize: 1024,
      timeout: Duration.seconds(10),
      layers: [webAdapterLayer(this, props.lwaLayerVersion)],
      environment: {
        ...WEB_ADAPTER_ENV,
        NODE_OPTIONS: '--enable-source-maps',
        AUTH_MODE: 'cognito',
        PUBLIC_BASE_URL: publicBaseUrl,
        // Our API host serves the RFC 8414 facade, so it is the issuer Alexa sees.
        AUTH_ISSUER_URL: publicBaseUrl,
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_CLIENT_IDS: props.clientIds.join(','),
        COGNITO_DOMAIN: props.cognitoDomain,
        OAUTH_PROXY: String(props.oauthProxy),
        TABLE_NAME: props.table.tableName,
        QUEUE_MODE: 'sqs',
        QUEUE_URL: props.queue.queueUrl,
        MAIL_MODE: 'ses',
        CRYPTO_MODE: 'kms',
        KMS_KEY_ID: props.key.keyArn,
        CORS_ORIGINS: props.corsOrigins.join(','),
        CARD_HTML_PATH: '/var/task/card.html',
        ...(props.demo && this.devKey
          ? { DEV_ENDPOINTS: 'true', DEV_KEY: this.devKey.secretValue.unsafeUnwrap() }
          : { DEV_ENDPOINTS: 'false' }),
      },
      bundling: {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp "${inputDir}/packages/ui-card/dist/index.html" "${outputDir}/card.html"`,
            `printf '#!/bin/sh\\nexec node /var/task/index.mjs\\n' > "${outputDir}/run.sh"`,
            `chmod +x "${outputDir}/run.sh"`,
          ],
        },
      },
    });
    // The Web Adapter runs run.sh, which starts our HTTP server; NodejsFunction would otherwise set index.<handler>.
    (fn.node.defaultChild as CfnFunction).handler = 'run.sh';

    props.table.grantReadWriteData(fn);
    props.key.grantEncryptDecrypt(fn);
    props.queue.grantSendMessages(fn);

    const alias = new Alias(this, 'Live', {
      aliasName: 'live',
      version: fn.currentVersion,
      ...(props.demo ? { provisionedConcurrentExecutions: 2 } : {}),
    });

    const api = new HttpApi(this, 'HttpApi', {
      apiName: 'care-circle',
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', alias),
    });

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint, description: 'Use as -c publicBaseUrl on the next deploy' });
    new CfnOutput(this, 'McpUrl', { value: `${publicBaseUrl}/mcp` });
    if (this.devKey) new CfnOutput(this, 'DevKeySecretArn', { value: this.devKey.secretArn });
  }
}
