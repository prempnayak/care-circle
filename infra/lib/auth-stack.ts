import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  FeaturePlan,
  LambdaVersion,
  ManagedLoginVersion,
  OAuthScope,
  ResourceServerScope,
  UserPool,
  UserPoolClientIdentityProvider,
  UserPoolOperation,
  UserPoolResourceServer,
} from 'aws-cdk-lib/aws-cognito';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { repoRoot } from './bundling';
import type { Construct } from 'constructs';

export interface AuthStackProps extends StackProps {
  domainPrefix: string;
  /** Alexa's account-linking redirect URIs, copied from the Alexa developer console (human task). */
  alexaRedirectUris: string[];
  dashboardUrl: string;
  simAgentUrl: string;
}

/**
 * Cognito user pool with managed login, resource server `carecircle` + scope `circle`, and app clients:
 * `alexa` (confidential, code grant, refresh tokens), `simulator` and `dashboard` (public, PKCE).
 * Alexa doesn't support DCR, so clients are statically registered here.
 */
export class AuthStack extends Stack {
  readonly userPool: UserPool;
  readonly clientIds: string[];
  readonly simulatorClientId: string;
  readonly dashboardClientId: string;
  readonly cognitoDomain: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const preToken = new NodejsFunction(this, 'PreTokenGeneration', {
      entry: `${repoRoot}infra/lambda/pre-token.ts`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(5),
    });

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: 'care-circle',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true }, givenName: { required: true, mutable: true } },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // Access-token customization (the V2 pre-token trigger) needs the Essentials plan.
      featurePlan: FeaturePlan.ESSENTIALS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.userPool.addTrigger(UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, preToken, LambdaVersion.V2_0);

    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: props.domainPrefix },
      // The classic hosted UI needs no branding resource; switch to NEWER_MANAGED_LOGIN with a CfnManagedLoginBranding.
      managedLoginVersion: ManagedLoginVersion.CLASSIC_HOSTED_UI,
    });
    this.cognitoDomain = `${props.domainPrefix}.auth.${this.region}.amazoncognito.com`;
    void domain;

    const circleScope = new ResourceServerScope({ scopeName: 'circle', scopeDescription: 'Use Care Circle' });
    const resourceServer = new UserPoolResourceServer(this, 'ResourceServer', {
      userPool: this.userPool,
      identifier: 'carecircle',
      scopes: [circleScope],
    });
    const scopes = [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE, OAuthScope.resourceServer(resourceServer, circleScope)];
    const common = {
      userPool: this.userPool,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(60),
      preventUserExistenceErrors: true,
    };

    const alexa = this.userPool.addClient('AlexaClient', {
      ...common,
      userPoolClientName: 'alexa',
      generateSecret: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes,
        callbackUrls: props.alexaRedirectUris.length > 0 ? props.alexaRedirectUris : ['https://pitangui.amazon.com/api/skill/link/PLACEHOLDER'],
      },
    });
    const simulator = this.userPool.addClient('SimulatorClient', {
      ...common,
      userPoolClientName: 'simulator',
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes,
        callbackUrls: [`${props.simAgentUrl.replace(/\/$/, '')}/link/callback`],
        // Each link first clears the Cognito session cookie so a persona never links as the last signed-in user.
        logoutUrls: [`${props.simAgentUrl.replace(/\/$/, '')}/link/resume`],
      },
    });
    const dashboard = this.userPool.addClient('DashboardClient', {
      ...common,
      userPoolClientName: 'dashboard',
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes,
        callbackUrls: [`${props.dashboardUrl.replace(/\/$/, '')}/callback`],
        logoutUrls: [`${props.dashboardUrl.replace(/\/$/, '')}/`],
      },
    });
    for (const c of [alexa, simulator, dashboard]) c.node.addDependency(resourceServer);

    this.clientIds = [alexa.userPoolClientId, simulator.userPoolClientId, dashboard.userPoolClientId];
    this.simulatorClientId = simulator.userPoolClientId;
    this.dashboardClientId = dashboard.userPoolClientId;

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'CognitoDomain', { value: this.cognitoDomain });
    new CfnOutput(this, 'AlexaClientId', { value: alexa.userPoolClientId, description: 'Secret: Cognito console → App clients → alexa' });
    new CfnOutput(this, 'SimulatorClientId', { value: simulator.userPoolClientId });
    new CfnOutput(this, 'DashboardClientId', { value: dashboard.userPoolClientId });
  }
}
