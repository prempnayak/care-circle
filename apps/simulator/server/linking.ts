/**
 * Alexa-style account linking: after a 401 with no WWW-Authenticate, fetch the Protected Resource
 * Metadata, then the authorization server's RFC 8414 metadata (checking S256), then run the
 * authorization code flow with PKCE S256 and the `resource` parameter on both requests, using a
 * pre-registered static client_id. Tokens are kept per persona and refreshed on expiry.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Tokens, TraceEntry } from './types';

interface Discovery {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

interface PendingLink {
  persona: string;
  verifier: string;
  discovery: Discovery;
  createdAt: number;
}

async function timedJson(url: string, trace: TraceEntry[], label: string, init?: RequestInit) {
  const started = performance.now();
  const res = await fetch(url, init);
  trace.push({ at: new Date().toISOString(), kind: 'oauth', label, status: res.status, ms: Math.round(performance.now() - started) });
  if (!res.ok) throw new Error(`${label} failed with ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

export class Linker {
  private pending = new Map<string, PendingLink>();

  constructor(
    private readonly mcpUrl: string,
    private readonly clientId: string,
    private readonly redirectUri: string,
  ) {}

  async discover(trace: TraceEntry[]): Promise<Discovery> {
    const origin = new URL(this.mcpUrl).origin;
    const prm = await timedJson(`${origin}/.well-known/oauth-protected-resource`, trace, 'GET /.well-known/oauth-protected-resource');
    const issuer = (prm.authorization_servers as string[] | undefined)?.[0];
    if (!issuer) throw new Error('No authorization server in the protected resource metadata');
    // Alexa uses only the first authorization server.
    const as = await timedJson(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`, trace, 'GET AS /.well-known/oauth-authorization-server');
    const methods = (as.code_challenge_methods_supported as string[] | undefined) ?? [];
    if (!methods.includes('S256')) throw new Error('Authorization server does not support PKCE S256');
    trace.push({ at: new Date().toISOString(), kind: 'oauth', label: 'S256 supported ✓', detail: `resource=${prm.resource}` });
    return {
      resource: String(prm.resource),
      issuer,
      authorizationEndpoint: String(as.authorization_endpoint),
      tokenEndpoint: String(as.token_endpoint),
    };
  }

  /** Build the authorize URL for a persona (PKCE S256 + resource). */
  async start(persona: string, trace: TraceEntry[]): Promise<{ authorizeUrl: string; resource: string; issuer: string }> {
    const discovery = await this.discover(trace);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = `${persona}.${randomBytes(12).toString('base64url')}`;
    this.pending.set(state, { persona, verifier, discovery, createdAt: Date.now() });
    const url = new URL(discovery.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: discovery.resource,
      scope: 'openid carecircle/circle',
      state,
    }).toString();
    return { authorizeUrl: url.toString(), resource: discovery.resource, issuer: discovery.issuer };
  }

  async finish(code: string, state: string, trace: TraceEntry[]): Promise<{ persona: string; tokens: Tokens }> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || Date.now() - pending.createdAt > 10 * 60_000) throw new Error('Linking expired; try again');
    const t = await timedJson(pending.discovery.tokenEndpoint, trace, 'POST /token (authorization_code + PKCE + resource)', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        code_verifier: pending.verifier,
        client_id: this.clientId,
        resource: pending.discovery.resource,
      }),
    });
    return { persona: pending.persona, tokens: toTokens(t) };
  }

  async refresh(tokens: Tokens, trace: TraceEntry[]): Promise<Tokens | null> {
    if (!tokens.refreshToken) return null;
    const discovery = await this.discover(trace);
    try {
      const t = await timedJson(discovery.tokenEndpoint, trace, 'POST /token (refresh_token)', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
          client_id: this.clientId,
          resource: discovery.resource,
        }),
      });
      return toTokens(t);
    } catch {
      return null;
    }
  }
}

function toTokens(t: Record<string, unknown>): Tokens {
  return {
    accessToken: String(t.access_token),
    ...(t.refresh_token ? { refreshToken: String(t.refresh_token) } : {}),
    expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000,
  };
}
