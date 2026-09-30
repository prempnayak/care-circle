/**
 * OAuth 2.1 authorization code + PKCE (S256) against the active issuer (dev-auth locally, Cognito in the cloud),
 * with the RFC 8707 resource set to the dashboard API. Tokens live in sessionStorage for this tab only.
 */
export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const ISSUER = (import.meta.env.VITE_AUTH_ISSUER ?? 'http://localhost:8788').replace(/\/$/, '');
const CLIENT_ID = import.meta.env.VITE_DASHBOARD_CLIENT_ID ?? 'dashboard';
const RESOURCE = `${API_URL}/api`;
const REDIRECT = `${window.location.origin}/callback`;
const KEY = 'care-circle-dashboard';

interface Stored {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

interface AsMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
}

async function metadata(): Promise<AsMetadata> {
  const res = await fetch(`${ISSUER}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error('Sign-in service unavailable');
  return (await res.json()) as AsMetadata;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function signIn(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(`${KEY}:pkce`, JSON.stringify({ verifier, state }));
  const md = await metadata();
  const url = new URL(md.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'openid carecircle/circle',
    state,
  }).toString();
  window.location.assign(url.toString());
}

async function tokenRequest(body: Record<string, string>): Promise<Stored> {
  const md = await metadata();
  const res = await fetch(md.token_endpoint, { method: 'POST', body: new URLSearchParams({ client_id: CLIENT_ID, resource: RESOURCE, ...body }) });
  if (!res.ok) throw new Error('Sign-in failed');
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const stored = { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 };
  sessionStorage.setItem(KEY, JSON.stringify(stored));
  return stored;
}

/** Finish the redirect back from the authorization server. */
export async function completeSignIn(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const pkce = JSON.parse(sessionStorage.getItem(`${KEY}:pkce`) ?? 'null') as { verifier: string; state: string } | null;
  sessionStorage.removeItem(`${KEY}:pkce`);
  if (!pkce || params.get('state') !== pkce.state || !params.get('code')) throw new Error('Sign-in was interrupted. Please try again.');
  await tokenRequest({ grant_type: 'authorization_code', code: params.get('code')!, redirect_uri: REDIRECT, code_verifier: pkce.verifier });
  window.history.replaceState({}, '', '/');
}

export async function accessToken(): Promise<string | null> {
  const stored = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Stored | null;
  if (!stored) return null;
  if (stored.expiresAt - 30_000 > Date.now()) return stored.accessToken;
  if (!stored.refreshToken) return null;
  try {
    return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: stored.refreshToken })).accessToken;
  } catch {
    signOut();
    return null;
  }
}

export function signOut(): void {
  sessionStorage.removeItem(KEY);
}

export function isSignedIn(): boolean {
  return sessionStorage.getItem(KEY) !== null;
}
