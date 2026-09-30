import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from '@care-circle/core';

/** The caller, as proven by a verified access token. The token identifies the linked account, not the speaker. */
export interface AuthUser {
  sub: string;
  email?: string;
  givenName?: string;
  clientId: string;
  scopes: string[];
  token: string;
  expiresAt?: number;
  /** Which resource the token was issued for (MCP or dashboard API). */
  audience: string[];
}

export interface TokenVerifier {
  /** Returns the user, or null if the token is missing, invalid or expired. Never throws for bad tokens. */
  verify(token: string): Promise<AuthUser | null>;
}

export const REQUIRED_SCOPE = 'carecircle/circle';

/** Dev issuer (packages/dev-auth): RS256 JWTs checked against its JWKS, which jose caches after the first fetch. */
export class DevTokenVerifier implements TokenVerifier {
  private readonly jwks: JWTVerifyGetKey;

  constructor(
    private readonly issuer: string,
    private readonly audiences: string[],
    jwks?: JWTVerifyGetKey,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.jwks = jwks ?? createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/.well-known/jwks.json`), { cacheMaxAge: 60 * 60 * 1000 });
  }

  async verify(token: string): Promise<AuthUser | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer.replace(/\/$/, ''),
        audience: this.audiences,
        algorithms: ['RS256'],
        currentDate: this.now(),
      });
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      if (!scopes.includes(REQUIRED_SCOPE) || !payload.sub) return null;
      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        givenName: typeof payload.given_name === 'string' ? payload.given_name : undefined,
        clientId: typeof payload.client_id === 'string' ? payload.client_id : 'unknown',
        scopes,
        token,
        expiresAt: payload.exp,
        audience: Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [],
      };
    } catch {
      return null;
    }
  }
}

/**
 * Cognito access tokens: issuer is the pool, token_use = access, client_id in the allowed set,
 * not expired, and scope includes carecircle/circle. Email and given_name come from a
 * pre-token-generation trigger (see infra/), since Cognito access tokens don't carry them by default.
 */
export class CognitoTokenVerifier implements TokenVerifier {
  private readonly verifier;

  constructor(userPoolId: string, clientIds: string[]) {
    this.verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'access', clientId: clientIds, scope: REQUIRED_SCOPE });
  }

  async hydrate(): Promise<void> {
    await this.verifier.hydrate();
  }

  async verify(token: string): Promise<AuthUser | null> {
    try {
      const payload = (await this.verifier.verify(token)) as Record<string, unknown>;
      return {
        sub: String(payload.sub),
        email: typeof payload.email === 'string' ? payload.email : undefined,
        givenName: typeof payload.given_name === 'string' ? payload.given_name : undefined,
        clientId: String(payload.client_id),
        scopes: String(payload.scope ?? '').split(' '),
        token,
        expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
        audience: [],
      };
    } catch {
      return null;
    }
  }
}

/** `audience` is the resource the token must be for: the MCP URL for /mcp, the API URL for /api. */
export function createVerifier(config: Config, audience: string): TokenVerifier {
  if (config.AUTH_MODE === 'cognito') {
    if (!config.COGNITO_USER_POOL_ID || config.cognitoClientIds.length === 0) {
      throw new Error('AUTH_MODE=cognito needs COGNITO_USER_POOL_ID and COGNITO_CLIENT_IDS');
    }
    return new CognitoTokenVerifier(config.COGNITO_USER_POOL_ID, config.cognitoClientIds);
  }
  return new DevTokenVerifier(config.AUTH_ISSUER_URL, [audience]);
}

export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}
