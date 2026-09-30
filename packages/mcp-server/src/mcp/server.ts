import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { Services } from '@care-circle/core';
import type { AuthUser } from '../auth/verifier';
import { CARD_URI, inputs, meta, outputs, runTool, TOOL_NAMES, type Outcome, type ToolName } from '../tools';

export const SERVER_INFO = { name: 'care-circle', title: 'Care Circle', version: '0.1.0' };

const CARD_FALLBACK = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Care Circle</title></head>
<body style="font-family:system-ui;font-size:24px"><p>The Care Circle card hasn't been built yet. Run: npm -w @care-circle/ui-card run build</p></body></html>`;

let cardHtmlCache: string | null = null;

/** The single-file card from packages/ui-card (built by Vite + vite-plugin-singlefile). */
export function loadCardHtml(): string {
  if (cardHtmlCache) return cardHtmlCache;
  const candidates = [
    process.env.CARD_HTML_PATH,
    fileURLToPath(new URL('../../../ui-card/dist/index.html', import.meta.url)),
    `${process.cwd()}/card.html`,
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  cardHtmlCache = found ? readFileSync(found, 'utf8') : CARD_FALLBACK;
  return cardHtmlCache;
}

/**
 * Publishes the zod schema's JSON Schema in tools/list but lets every argument through to the tool,
 * which validates with the same zod schema and answers bad input with a speakable message
 * (the SDK's own validation error, "Input validation error: …", isn't fit to be spoken).
 */
export function publishedSchema<T extends { '~standard': { jsonSchema: unknown } }>(schema: T) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'care-circle',
      validate: (value: unknown) => ({ value }),
      jsonSchema: schema['~standard'].jsonSchema,
    },
  } as unknown as T;
}

/** MCP tool result envelope (handoff §8.4): speech text, then the JSON text; structuredContent; card _meta. */
export function toCallToolResult(name: ToolName, outcome: Outcome<ToolName>): CallToolResult {
  if (!outcome.ok) {
    return { isError: true, content: [{ type: 'text', text: outcome.speech }] };
  }
  const structured = outcome.output as Record<string, unknown> & { speech: string };
  const result: CallToolResult = {
    content: [
      { type: 'text', text: structured.speech },
      { type: 'text', text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
  };
  if (meta[name].card) {
    result._meta = { ui: { resourceUri: CARD_URI, invoking: 'Checking today…', invoked: "Here's today" } };
  }
  return result;
}

/**
 * A fresh server per request (the endpoint is stateless). Handlers close over the verified caller;
 * with no token the caller is null and only care_circle_help does anything useful.
 */
export function buildMcpServer(services: Services, user: AuthUser | null): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    instructions:
      'Care Circle is a family communication tool, not a medical or emergency service. Keep replies to two sentences, never read notes aloud to caregivers, and send anyone describing an injury to 911 (or 988 for thoughts of self-harm) first.',
  });

  for (const name of TOOL_NAMES) {
    const m = meta[name];
    const config = {
      title: m.title,
      description: m.description,
      inputSchema: publishedSchema(inputs[name]),
      outputSchema: outputs[name],
      annotations: { title: m.title, readOnlyHint: m.readOnly, destructiveHint: false, idempotentHint: m.readOnly, openWorldHint: false },
    };
    const handler = async (args: unknown) => toCallToolResult(name, await runTool(name, { services, user }, args));
    if (m.card) {
      registerAppTool(server, name, { ...config, _meta: { ui: { resourceUri: CARD_URI } } }, handler as never);
    } else {
      server.registerTool(name, config, handler as never);
    }
  }

  registerAppResource(
    server,
    'Care Circle today',
    CARD_URI,
    { description: "Today's check-in and medicine checklist, read-only.", mimeType: RESOURCE_MIME_TYPE },
    async () => ({ contents: [{ uri: CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: loadCardHtml() }] }),
  );

  return server;
}
