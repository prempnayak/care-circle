/**
 * Prints dev access tokens (via the real code + PKCE + resource flow against dev-auth) as env lines,
 * for k6 and manual testing:  eval "$(npm run -s tokens)"
 */
import { createHash, randomBytes } from 'node:crypto';

const issuer = process.env.AUTH_ISSUER_URL ?? 'http://localhost:8788';
const resource = `${(process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '')}/mcp`;
const redirect = 'http://localhost/test-callback';

export async function devToken(user: string): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = { client_id: 'test-client', redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource };
  const approve = await fetch(`${issuer}/authorize`, { method: 'POST', body: new URLSearchParams({ ...q, user }), redirect: 'manual' });
  const code = new URL(approve.headers.get('location')!).searchParams.get('code')!;
  const res = await fetch(`${issuer}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: 'test-client', resource }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

if (process.argv[1]?.endsWith('mint-tokens.ts')) {
  console.log(`export TOKEN_RECIPIENT=${await devToken('dev-margaret')}`);
  console.log(`export TOKEN_CAREGIVER=${await devToken('dev-sarah')}`);
}
