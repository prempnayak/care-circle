import { fileURLToPath } from 'node:url';
import { Duration } from 'aws-cdk-lib';
import { Architecture, LayerVersion, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** ESM bundle for Node 22 on arm64, with a `require` shim for CommonJS dependencies. */
export function nodeFunction(scope: Construct, id: string, props: NodejsFunctionProps & { entry: string }) {
  return new NodejsFunction(scope, id, {
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    memorySize: 512,
    timeout: Duration.seconds(30),
    projectRoot: repoRoot,
    depsLockFilePath: `${repoRoot}package-lock.json`,
    ...props,
    bundling: {
      format: OutputFormat.ESM,
      target: 'node22',
      mainFields: ['module', 'main'],
      banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      ...props.bundling,
    },
  });
}

/**
 * AWS Lambda Web Adapter layer (runs our ordinary Node HTTP server inside Lambda).
 * Verified Oct 1, 2026 at github.com/awslabs/aws-lambda-web-adapter: layer version 30.
 */
export function webAdapterLayer(scope: Construct, version: number) {
  return LayerVersion.fromLayerVersionArn(
    scope,
    'LambdaWebAdapter',
    `arn:aws:lambda:${(scope as unknown as { region: string }).region}:753240598075:layer:LambdaAdapterLayerArm64:${version}`,
  );
}

/** Env for a zip-packaged server behind the Lambda Web Adapter (handler = run.sh). */
export const WEB_ADAPTER_ENV = {
  AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
  AWS_LWA_PORT: '8080',
  PORT: '8080',
  AWS_LWA_READINESS_CHECK_PATH: '/healthz',
};
