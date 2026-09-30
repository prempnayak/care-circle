import {
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import type { Services } from '@care-circle/core';
import { bearerToken, type AuthUser, type TokenVerifier } from '../auth/verifier';
import { PUBLIC_TOOLS } from '../tools';
import { buildMcpServer } from './server';

/** Methods that never need a token (handoff §8.2). A token, if valid, is still attached. */
const OPEN_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'prompts/list',
  'server/discover',
]);

export const UNAUTHORIZED_BODY = { error: 'unauthorized', message: 'Access token required to use this tool.' };

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: unknown } & Record<string, unknown>;
}

function jsonRpcError(status: number, code: number, message: string, id: JsonRpcMessage['id'] = null): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id }, { status });
}

/** Does this message need a valid token? Only tools/call for a tool other than care_circle_help. */
export function requiresToken(msg: JsonRpcMessage): boolean {
  if (!msg.method) return false; // a JSON-RPC response from the client
  if (msg.method.startsWith('notifications/')) return false;
  if (OPEN_METHODS.has(msg.method)) return false;
  if (msg.method === 'tools/call') return !PUBLIC_TOOLS.has(String(msg.params?.name ?? ''));
  return false;
}

function toAuthInfo(user: AuthUser): AuthInfo {
  return {
    token: user.token,
    clientId: user.clientId,
    scopes: user.scopes,
    ...(user.expiresAt ? { expiresAt: user.expiresAt } : {}),
    extra: { sub: user.sub },
  };
}

/**
 * POST /mcp. The auth gate reads the JSON-RPC body before the transport so a protected tool called
 * without a valid token gets a real HTTP 401 with no WWW-Authenticate header (Alexa's rule).
 *
 * 2025-era clients (2025-11-25, and 2025-03-26 as Amazon's sample sends) are served by a per-request
 * stateless transport with JSON responses; the SDK's built-in legacy fallback streams SSE instead.
 * 2026-era clients go to the SDK's createMcpHandler in JSON mode.
 */
export function createMcpEndpoint(services: Services, verifier: TokenVerifier) {
  const modern = createMcpHandler(
    ({ authInfo }) => buildMcpServer(services, (authInfo?.extra?.user as AuthUser | undefined) ?? null),
    { legacy: 'reject', responseMode: 'json', onerror: (err) => services.logger.warn('mcp modern handler error', { err }) },
  );

  return async function handle(request: Request): Promise<Response> {
    if (request.method === 'GET' || request.method === 'DELETE') {
      // Stateless: no server-initiated SSE stream and no sessions to delete.
      return new Response(JSON.stringify({ error: 'method_not_allowed', message: 'Use POST for MCP requests.' }), {
        status: 405,
        headers: { allow: 'POST', 'content-type': 'application/json' },
      });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return jsonRpcError(415, -32000, 'Content-Type must be application/json');
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonRpcError(400, -32700, 'Parse error');
    }
    if (Array.isArray(body)) {
      // JSON-RPC batching was removed from MCP after 2025-03-26; Alexa doesn't send batches.
      return jsonRpcError(400, -32600, 'Batch requests are not supported');
    }
    const msg = body as JsonRpcMessage;
    if (!msg || typeof msg !== 'object') return jsonRpcError(400, -32600, 'Invalid request');

    const token = bearerToken(request.headers.get('authorization'));
    const user = token ? await verifier.verify(token) : null;
    if (requiresToken(msg) && !user) {
      services.logger.info('mcp unauthorized', { method: msg.method, tool: msg.params?.name, hadToken: Boolean(token) });
      // Deliberately no WWW-Authenticate header.
      return Response.json(UNAUTHORIZED_BODY, { status: 401 });
    }

    const authInfo = user ? { ...toAuthInfo(user), extra: { sub: user.sub, user } } : undefined;
    const rebuilt = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) });

    if (await isLegacyRequest(rebuilt, body)) {
      const server = buildMcpServer(services, user);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(rebuilt, { parsedBody: body, ...(authInfo ? { authInfo } : {}) });
      } finally {
        void server.close();
      }
    }
    return modern.fetch(rebuilt, { parsedBody: body, ...(authInfo ? { authInfo } : {}) });
  };
}
