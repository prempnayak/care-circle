import { Hono } from 'hono';
import type { Config } from '@care-circle/core';
import { REQUIRED_SCOPE } from './auth/verifier';

export const SCOPES_SUPPORTED = ['openid', REQUIRED_SCOPE];

/** RFC 9728 Protected Resource Metadata. `resource` must match the MCP URL exactly. */
export function protectedResourceMetadata(config: Config) {
  return {
    resource: config.mcpResource,
    authorization_servers: [config.AUTH_ISSUER_URL.replace(/\/$/, '')],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'Care Circle',
  };
}

/**
 * RFC 8414 metadata, served here only when this host is also the issuer (the Cognito facade).
 * Option (a) points straight at Cognito's endpoints; option (b) at our thin /oauth proxy, which
 * drops the `resource` parameter Cognito may not accept (decided by the Phase 0 spike).
 */
export function authorizationServerMetadata(config: Config) {
  const issuer = config.AUTH_ISSUER_URL.replace(/\/$/, '');
  const cognito = `https://${config.COGNITO_DOMAIN}`;
  return {
    issuer,
    authorization_endpoint: config.OAUTH_PROXY ? `${issuer}/oauth/authorize` : `${cognito}/oauth2/authorize`,
    token_endpoint: config.OAUTH_PROXY ? `${issuer}/oauth/token` : `${cognito}/oauth2/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: SCOPES_SUPPORTED,
  };
}

export function createWellKnownRoutes(config: Config) {
  const app = new Hono();
  const prm = () => protectedResourceMetadata(config);
  app.get('/oauth-protected-resource', (c) => c.json(prm()));
  // RFC 9728 §3.1 path-suffixed form, for clients that append the resource path.
  app.get('/oauth-protected-resource/mcp', (c) => c.json(prm()));

  const selfIssued = config.AUTH_MODE === 'cognito' && config.AUTH_ISSUER_URL.replace(/\/$/, '') === config.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (selfIssued) {
    app.get('/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(config)));
  }
  return app;
}

/** Option (b): forward authorize/token to Cognito without the `resource` parameter. */
export function createOAuthProxyRoutes(config: Config) {
  const app = new Hono();
  const cognito = `https://${config.COGNITO_DOMAIN}`;
  app.get('/authorize', (c) => {
    const url = new URL(`${cognito}/oauth2/authorize`);
    for (const [k, v] of Object.entries(c.req.query())) if (k !== 'resource') url.searchParams.set(k, v);
    return c.redirect(url.toString(), 302);
  });
  app.post('/token', async (c) => {
    const form = new URLSearchParams(await c.req.text());
    form.delete('resource');
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const auth = c.req.header('authorization');
    if (auth) headers.authorization = auth;
    const res = await fetch(`${cognito}/oauth2/token`, { method: 'POST', headers, body: form.toString() });
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  });
  return app;
}
