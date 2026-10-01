/**
 * The simulator's MCP client. It uses the official MCP client SDK over Streamable HTTP, a fresh
 * connection per turn (the server is stateless), and records every HTTP exchange for the trace panel.
 * A 401 from a tool call surfaces as NeedsLinking, which starts Alexa-style account linking.
 */
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import type { ToolCallRecord, TraceEntry } from './types';

export class NeedsLinking extends Error {
  constructor() {
    super('Account linking required');
  }
}

export interface Connection {
  tools: Tool[];
  call(name: string, args: Record<string, unknown>): Promise<ToolCallRecord & { raw: CallToolResult }>;
  readResource(uri: string): Promise<string>;
  close(): Promise<void>;
}

function describe(body: unknown): string {
  try {
    const msg = JSON.parse(String(body)) as { method?: string; params?: { name?: string; uri?: string } };
    if (msg.method === 'tools/call') return `tools/call ${msg.params?.name}`;
    if (msg.method === 'resources/read') return `resources/read ${msg.params?.uri}`;
    return msg.method ?? 'response';
  } catch {
    return body ? 'request' : '(open SSE stream)';
  }
}

export async function connect(mcpUrl: string, accessToken: string | undefined, trace: TraceEntry[]): Promise<Connection> {
  let lastStatus = 0;
  const tracingFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
    const started = performance.now();
    const res = await fetch(url, { ...init, headers });
    lastStatus = res.status;
    trace.push({
      at: new Date().toISOString(),
      kind: 'mcp',
      label: `${init?.method ?? 'GET'} /mcp ${describe(init?.body)}`,
      status: res.status,
      ms: Math.round(performance.now() - started),
      ...(res.status === 401 ? { detail: `WWW-Authenticate: ${res.headers.get('www-authenticate') ?? '(none)'}` } : {}),
      ...(res.status === 405 && init?.method === 'GET' ? { detail: 'expected: stateless server offers no SSE stream' } : {}),
    });
    return res;
  };

  const client = new Client({ name: 'care-circle-simulator', version: '0.1.0' }, { capabilities: { roots: {} } });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { fetch: tracingFetch });
  await client.connect(transport);
  const { tools } = await client.listTools();

  return {
    tools,
    async call(name, args) {
      try {
        const raw = (await client.callTool({ name, arguments: args })) as CallToolResult;
        const content = (raw.content ?? []) as { type: string; text?: string }[];
        const meta = raw._meta as { ui?: { resourceUri?: string } } | undefined;
        return {
          name,
          args,
          status: lastStatus,
          isError: Boolean(raw.isError),
          speech: content[0]?.text ?? '',
          ...(raw.structuredContent ? { structuredContent: raw.structuredContent as Record<string, unknown> } : {}),
          ...(meta?.ui?.resourceUri ? { cardUri: meta.ui.resourceUri } : {}),
          raw,
        };
      } catch (err) {
        if (lastStatus === 401) throw new NeedsLinking();
        throw err;
      }
    },
    async readResource(uri) {
      const res = await client.readResource({ uri });
      const first = res.contents[0] as { text?: string } | undefined;
      return first?.text ?? '';
    },
    close: () => client.close(),
  };
}
