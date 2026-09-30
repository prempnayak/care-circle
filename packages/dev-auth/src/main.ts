import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createDevAuthApp } from './app';
import { devClients } from './clients';

const issuer = process.env.AUTH_ISSUER_URL ?? 'http://localhost:8788';
const base = (process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const port = Number(new URL(issuer).port || 8788);

const { app } = await createDevAuthApp({
  issuer,
  resources: [`${base}/mcp`, `${base}/api`],
  clients: devClients(process.env),
  accessTtlSec: Number(process.env.DEV_ACCESS_TTL_SEC ?? 3600),
  keyFile: fileURLToPath(new URL('../.keys/signing-key.json', import.meta.url)),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174').split(','),
});

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`dev-auth listening on ${issuer}`);
});
