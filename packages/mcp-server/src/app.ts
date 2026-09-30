import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Services } from '@care-circle/core';
import { createApiRoutes } from './api/routes';
import { createVerifier, type TokenVerifier } from './auth/verifier';
import { createDevRoutes } from './dev';
import { createMcpEndpoint } from './mcp/handler';
import { createOAuthProxyRoutes, createWellKnownRoutes } from './wellknown';

export interface AppOptions {
  /** Override the token verifiers (tests). */
  mcpVerifier?: TokenVerifier;
  apiVerifier?: TokenVerifier;
}

/** The API: POST /mcp, /.well-known/*, /api/*, /dev/* and /healthz, all on one Node server. */
export function createApp(services: Services, opts: AppOptions = {}) {
  const { config } = services;
  const app = new Hono();
  const mcpVerifier = opts.mcpVerifier ?? createVerifier(config, config.mcpResource);
  const apiVerifier = opts.apiVerifier ?? createVerifier(config, config.apiResource);

  app.use(
    '*',
    cors({
      origin: config.corsOrigins,
      allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version', 'x-dev-key'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['mcp-protocol-version'],
    }),
  );

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/.well-known', createWellKnownRoutes(config));
  if (config.AUTH_MODE === 'cognito' && config.OAUTH_PROXY) app.route('/oauth', createOAuthProxyRoutes(config));

  const mcp = createMcpEndpoint(services, mcpVerifier);
  app.all('/mcp', (c) => mcp(c.req.raw));

  app.route('/api', createApiRoutes(services, apiVerifier));
  if (config.DEV_ENDPOINTS) app.route('/dev', createDevRoutes(services));
  return app;
}
