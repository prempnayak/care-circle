/**
 * Runs dev-auth and the API in-process on test ports, backed by a fresh DynamoDB Local table,
 * and completes the OAuth code + PKCE + resource flow the way Alexa (or our simulator) does.
 */
import { createHash, randomBytes } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { seedDemo } from '@care-circle/core';
import { createDevAuthApp, DEMO_USERS } from '@care-circle/dev-auth';
import { createApp } from '@care-circle/mcp-server';
import { testServices, type TestServices } from '../support/services';

export interface Harness {
  s: TestServices;
  api: string;
  mcp: string;
  issuer: string;
  /** Shift dev-auth's clock (to mint already-expired tokens). */
  authClockOffsetMs: { value: number };
  close: () => Promise<void>;
}

export async function startHarness(apiPort: number, authPort: number): Promise<Harness> {
  const api = `http://localhost:${apiPort}`;
  const issuer = `http://localhost:${authPort}`;
  const s = await testServices('2026-10-06T12:35:00Z', { PUBLIC_BASE_URL: api, AUTH_ISSUER_URL: issuer });
  await seedDemo(s.store, s.clock, s.crypto);
  const authClockOffsetMs = { value: 0 };
  const { app: authApp } = await createDevAuthApp({
    issuer,
    resources: [`${api}/mcp`, `${api}/api`],
    clients: [
      { clientId: 'test-client', redirectUris: ['http://localhost/test-callback'] },
      { clientId: 'alexa', secret: 'alexa-secret', redirectUris: ['https://pitangui.amazon.com/api/skill/link/TEST'] },
    ],
    users: DEMO_USERS,
    now: () => new Date(Date.now() + authClockOffsetMs.value),
  });
  const servers: ServerType[] = [];
  await new Promise<void>((r) => servers.push(serve({ fetch: authApp.fetch, port: authPort }, () => r())));
  await new Promise<void>((r) => servers.push(serve({ fetch: createApp(s).fetch, port: apiPort }, () => r())));
  return {
    s,
    api,
    mcp: `${api}/mcp`,
    issuer,
    authClockOffsetMs,
    close: async () => {
      await Promise.all(servers.map((srv) => new Promise((r) => srv.close(() => r(undefined)))));
      await s.queue.drain();
      await s.cleanup();
    },
  };
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Authorization code + PKCE S256 + resource, signing in as `user` on the dev authorize page. */
export async function link(h: Harness, user: string, resource = h.mcp): Promise<Tokens> {
  const { verifier, challenge } = pkce();
  const redirect = 'http://localhost/test-callback';
  const q = {
    client_id: 'test-client',
    redirect_uri: redirect,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
    state: 'xyz',
    scope: 'openid carecircle/circle',
  };
  const page = await fetch(`${h.issuer}/authorize?${new URLSearchParams(q)}`);
  if (page.status !== 200) throw new Error(`authorize page ${page.status}`);
  const approve = await fetch(`${h.issuer}/authorize`, { method: 'POST', body: new URLSearchParams({ ...q, user }), redirect: 'manual' });
  const location = new URL(approve.headers.get('location')!);
  if (location.searchParams.get('state') !== 'xyz') throw new Error('state mismatch');
  const token = await fetch(`${h.issuer}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: location.searchParams.get('code')!,
      redirect_uri: redirect,
      code_verifier: verifier,
      client_id: 'test-client',
      resource,
    }),
  });
  if (token.status !== 200) throw new Error(`token ${token.status}: ${await token.text()}`);
  return (await token.json()) as Tokens;
}

export async function refresh(h: Harness, refreshToken: string): Promise<Tokens> {
  const res = await fetch(`${h.issuer}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'test-client', resource: h.mcp }),
  });
  if (res.status !== 200) throw new Error(`refresh ${res.status}`);
  return (await res.json()) as Tokens;
}

let rpcId = 1;
/** A raw JSON-RPC POST, the way Alexa sends it. */
export async function rpc(h: Harness, method: string, params: unknown, opts: { token?: string; protocol?: string } = {}) {
  const res = await fetch(h.mcp, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(opts.protocol ? { 'mcp-protocol-version': opts.protocol } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}
