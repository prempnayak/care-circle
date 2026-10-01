/**
 * Local OAuth 2.1 authorization server (dev only, never deployed).
 *
 * It exists so the same Alexa-style linking flow runs locally: authorization code + PKCE S256,
 * the RFC 8707 `resource` parameter on both requests, refresh tokens, static client registration,
 * and RS256 JWT access tokens with aud = resource.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';

export interface DevClient {
  clientId: string;
  /** Confidential clients (Alexa) have a secret; public clients (dashboard, simulator) don't. */
  secret?: string;
  redirectUris: string[];
}

export interface DevUser {
  sub: string;
  givenName: string;
  email: string;
  label: string;
}

export interface DevAuthOptions {
  issuer: string;
  /** Resources a token may be issued for (the MCP URL and the dashboard API). */
  resources: string[];
  clients: DevClient[];
  users?: DevUser[];
  accessTtlSec?: number;
  /** Persist the signing key here so tokens survive restarts. */
  keyFile?: string;
  corsOrigins?: string[];
  now?: () => Date;
}

export const DEMO_USERS: DevUser[] = [
  { sub: 'dev-margaret', givenName: 'Margaret', email: 'margaret@example.com', label: 'Margaret (78, the person Care Circle looks after)' },
  { sub: 'dev-sarah', givenName: 'Sarah', email: 'sarah@example.com', label: 'Sarah (daughter, lead caregiver)' },
  { sub: 'dev-tom', givenName: 'Tom', email: 'tom@example.com', label: 'Tom (son, family member)' },
];

export const SCOPES = ['openid', 'carecircle/circle'];

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  user: DevUser;
  expiresAt: number;
}

interface RefreshGrant {
  clientId: string;
  resource: string;
  scope: string;
  user: DevUser;
}

const html = (s: TemplateStringsArray, ...v: unknown[]) => s.reduce((acc, str, i) => acc + str + (i < v.length ? String(v[i]) : ''), '');

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function loadOrCreateKey(keyFile?: string): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  if (keyFile && existsSync(keyFile)) {
    return JSON.parse(readFileSync(keyFile, 'utf8')) as { privateJwk: JWK; publicJwk: JWK };
  }
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = randomBytes(8).toString('hex');
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: 'RS256', use: 'sig' };
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  if (keyFile) {
    mkdirSync(keyFile.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(keyFile, JSON.stringify({ privateJwk, publicJwk }), { mode: 0o600 });
  }
  return { privateJwk, publicJwk };
}

export async function createDevAuthApp(opts: DevAuthOptions) {
  const issuer = opts.issuer.replace(/\/$/, '');
  const now = opts.now ?? (() => new Date());
  const accessTtl = opts.accessTtlSec ?? 3600;
  const users = opts.users ?? DEMO_USERS;
  const { privateJwk, publicJwk } = await loadOrCreateKey(opts.keyFile);
  const signingKey = await importJWK(privateJwk, 'RS256');
  const codes = new Map<string, PendingCode>();
  const refreshTokens = new Map<string, RefreshGrant>();
  const newUsers = new Map<string, DevUser>();

  const app = new Hono();
  app.use('*', cors({ origin: opts.corsOrigins ?? '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }));

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: SCOPES,
  };

  app.get('/.well-known/oauth-authorization-server', (c) => c.json(metadata));
  app.get('/.well-known/jwks.json', (c) => c.json({ keys: [publicJwk] }));
  app.get('/healthz', (c) => c.json({ ok: true }));

  const findClient = (id: string | undefined) => opts.clients.find((cl) => cl.clientId === id);

  function authorizeError(message: string, status: 400 = 400) {
    return new Response(`<!doctype html><title>Sign-in error</title><p>${esc(message)}</p>`, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  function validateAuthorize(q: Record<string, string | undefined>): string | null {
    const client = findClient(q.client_id);
    if (!client) return 'Unknown client_id.';
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) return 'redirect_uri is not registered for this client.';
    if (q.response_type !== 'code') return 'response_type must be "code".';
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return 'PKCE with code_challenge_method=S256 is required.';
    if (!q.resource || !opts.resources.includes(q.resource)) return 'A valid resource parameter is required.';
    return null;
  }

  app.get('/authorize', (c) => {
    const q = c.req.query();
    const problem = validateAuthorize(q);
    if (problem) return authorizeError(problem);
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'resource', 'state', 'scope']
      .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] ?? '')}">`)
      .join('');
    const buttons = users
      .map(
        (u) =>
          html`<button name="user" value="${esc(u.sub)}" type="submit" aria-label="Sign in as ${esc(u.givenName)}">${esc(u.label)}</button>`,
      )
      .join('');
    return c.html(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Care Circle dev sign-in</title>
<style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;font-size:20px;color:#111;background:#fff}
h1{font-size:28px} button{display:block;width:100%;margin:10px 0;padding:14px;font-size:20px;border:2px solid #1a4d8f;border-radius:10px;background:#eef4fb;color:#0b2a52;cursor:pointer;text-align:left}
button:focus{outline:4px solid #f5a623} fieldset{border:1px solid #bbb;border-radius:10px;margin-top:20px}
label{display:block;margin-top:8px} input[type=text],input[type=email]{width:100%;font-size:18px;padding:8px;box-sizing:border-box}
.note{font-size:15px;color:#444}
</style></head><body>
<h1>Link your account</h1>
<p class="note">Local development sign-in. This page stands in for Login with Amazon or Cognito.</p>
<form method="post" action="/authorize">${hidden}
${buttons}
<fieldset><legend>New user</legend>
<label for="given_name">First name</label><input id="given_name" name="given_name" type="text" maxlength="40" autocomplete="off">
<label for="email">Email (test address)</label><input id="email" name="email" type="email" maxlength="80" autocomplete="off">
<button name="user" value="__new__" type="submit">Sign in as a new user</button>
</fieldset>
</form></body></html>`);
  });

  app.post('/authorize', async (c) => {
    const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]));
    const problem = validateAuthorize(form);
    if (problem) return authorizeError(problem);
    let user: DevUser | undefined;
    if (form.user === '__new__') {
      const givenName = (form.given_name ?? '').trim().slice(0, 40) || 'Friend';
      const sub = `dev-user-${randomBytes(6).toString('hex')}`;
      user = { sub, givenName, email: (form.email ?? '').trim() || `${sub}@example.com`, label: givenName };
      newUsers.set(sub, user);
    } else {
      user = users.find((u) => u.sub === form.user) ?? newUsers.get(form.user ?? '');
    }
    if (!user) return authorizeError('Unknown user.');
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      clientId: form.client_id!,
      redirectUri: form.redirect_uri!,
      codeChallenge: form.code_challenge!,
      resource: form.resource!,
      scope: form.scope || SCOPES.join(' '),
      user,
      expiresAt: now().getTime() + 5 * 60 * 1000,
    });
    const target = new URL(form.redirect_uri!);
    target.searchParams.set('code', code);
    if (form.state) target.searchParams.set('state', form.state);
    return c.redirect(target.toString(), 302);
  });

  async function issueTokens(grant: RefreshGrant) {
    const iat = Math.floor(now().getTime() / 1000);
    const accessToken = await new SignJWT({
      client_id: grant.clientId,
      scope: grant.scope,
      token_use: 'access',
      email: grant.user.email,
      given_name: grant.user.givenName,
    })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid!, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(grant.resource)
      .setSubject(grant.user.sub)
      .setIssuedAt(iat)
      .setExpirationTime(iat + accessTtl)
      .setJti(randomBytes(8).toString('hex'))
      .sign(signingKey);
    const refreshToken = randomBytes(32).toString('base64url');
    refreshTokens.set(refreshToken, grant);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTtl,
      refresh_token: refreshToken,
      scope: grant.scope,
    };
  }

  function tokenError(error: string, description: string, status: 400 | 401 = 400) {
    return new Response(JSON.stringify({ error, error_description: description }), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  app.post('/token', async (c) => {
    const body = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
    // Client authentication: HTTP Basic or form fields.
    let clientId = body.client_id;
    let clientSecret = body.client_secret;
    const basic = c.req.header('authorization');
    if (basic?.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id ?? '');
      clientSecret = decodeURIComponent(secret ?? '');
    }
    const client = findClient(clientId);
    if (!client) return tokenError('invalid_client', 'Unknown client.', 401);
    if (client.secret && client.secret !== clientSecret) return tokenError('invalid_client', 'Bad client credentials.', 401);

    c.header('cache-control', 'no-store');
    if (body.grant_type === 'authorization_code') {
      const pending = codes.get(body.code ?? '');
      codes.delete(body.code ?? '');
      if (!pending || pending.expiresAt < now().getTime()) return tokenError('invalid_grant', 'The code is invalid or expired.');
      if (pending.clientId !== client.clientId) return tokenError('invalid_grant', 'The code was issued to another client.');
      if (pending.redirectUri !== body.redirect_uri) return tokenError('invalid_grant', 'redirect_uri does not match.');
      if (!body.code_verifier || s256(body.code_verifier) !== pending.codeChallenge) {
        return tokenError('invalid_grant', 'PKCE verification failed.');
      }
      if (!body.resource || body.resource !== pending.resource) return tokenError('invalid_target', 'resource does not match.');
      return c.json(await issueTokens({ clientId: client.clientId, resource: pending.resource, scope: pending.scope, user: pending.user }));
    }
    if (body.grant_type === 'refresh_token') {
      const grant = refreshTokens.get(body.refresh_token ?? '');
      if (!grant || grant.clientId !== client.clientId) return tokenError('invalid_grant', 'The refresh token is invalid.');
      if (body.resource && body.resource !== grant.resource) return tokenError('invalid_target', 'resource does not match.');
      refreshTokens.delete(body.refresh_token!); // rotate
      return c.json(await issueTokens(grant));
    }
    return tokenError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  return { app, metadata, publicJwk, users };
}
