/**
 * MCP contract (handoff §16): both protocol versions, valid schemas, every tool callable,
 * isError on business errors, public methods without a token, 401 without WWW-Authenticate.
 * Uses the official MCP client SDK where it applies and raw JSON-RPC where Alexa's exact wire shape matters.
 */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { link, rpc, startHarness, type Harness } from './harness';

const TOOL_NAMES = [
  'care_circle_help',
  'check_in',
  'get_status',
  'get_todays_doses',
  'get_week_summary',
  'join_circle',
  'log_dose',
  'message_circle',
  'set_sharing',
];

let h: Harness;
let margaret: string;
let sarah: string;

beforeAll(async () => {
  h = await startHarness(18787, 18788);
  margaret = (await link(h, 'dev-margaret')).access_token;
  sarah = (await link(h, 'dev-sarah')).access_token;
});
afterAll(async () => h?.close());

async function sdkClient(token?: string) {
  const client = new Client({ name: 'contract-test', version: '1.0.0' }, { capabilities: { roots: {} } });
  const transport = new StreamableHTTPClientTransport(new URL(h.mcp), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  await client.connect(transport);
  return client;
}

describe('lifecycle and protocol versions', () => {
  it('initializes with 2025-11-25 through the MCP client SDK, without a token', async () => {
    const client = await sdkClient();
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getServerVersion()?.name).toBe('care-circle');
    await client.close();
  });

  it("initializes with 2025-03-26 (Amazon's sample handshake) and answers with JSON, not SSE", async () => {
    const r = await rpc(h, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: { roots: {} },
      clientInfo: { name: 'alexa-sample', version: '1.0' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.body.result.protocolVersion).toBe('2025-03-26');
    expect(r.body.result.capabilities.tools).toBeDefined();
    expect(r.body.result.capabilities.resources).toBeDefined();
    expect(r.headers.get('mcp-session-id')).toBeNull(); // stateless
  });

  it('acknowledges notifications/initialized and answers ping without a token', async () => {
    const res = await fetch(h.mcp, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
    expect((await rpc(h, 'ping', {}, { protocol: '2025-11-25' })).body.result).toEqual({});
  });

  it('rejects GET (no server stream) and JSON-RPC batches', async () => {
    expect((await fetch(h.mcp)).status).toBe(405);
    const batch = await fetch(h.mcp, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
    });
    expect(batch.status).toBe(400);
  });
});

describe('tools/list', () => {
  it('lists exactly the 9 tools without a token, with valid JSON Schemas', async () => {
    const client = await sdkClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    for (const tool of tools) {
      expect(tool.description?.includes('Use for:'), tool.name).toBe(true);
      expect(() => ajv.compile(tool.inputSchema), `${tool.name} input`).not.toThrow();
      expect(tool.outputSchema, `${tool.name} output`).toBeDefined();
      expect(() => ajv.compile(tool.outputSchema!), `${tool.name} output`).not.toThrow();
    }
    // Distinct descriptions.
    expect(new Set(tools.map((t) => t.description)).size).toBe(tools.length);
    await client.close();
  });

  it('declares the card on the tools that attach it', async () => {
    const client = await sdkClient();
    const { tools } = await client.listTools();
    const withCard = tools.filter((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri);
    expect(withCard.map((t) => t.name).sort()).toEqual(['get_status', 'get_todays_doses']);
    const res = await client.readResource({ uri: 'ui://care-circle/today' });
    expect(res.contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
    await client.close();
  });
});

describe('auth gate', () => {
  it('lets care_circle_help run without a token', async () => {
    const r = await rpc(h, 'tools/call', { name: 'care_circle_help', arguments: {} }, { protocol: '2025-11-25' });
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBeFalsy();
    expect(r.body.result.content[0].text).toContain('call 911');
  });

  it.each(TOOL_NAMES.filter((n) => n !== 'care_circle_help'))('%s without a token: HTTP 401, no WWW-Authenticate', async (name) => {
    const r = await rpc(h, 'tools/call', { name, arguments: {} }, { protocol: '2025-11-25' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect(r.body).toEqual({ error: 'unauthorized', message: 'Access token required to use this tool.' });
  });

  it('rejects a token issued for a different resource', async () => {
    const apiToken = (await link(h, 'dev-sarah', `${h.api}/api`)).access_token;
    const r = await rpc(h, 'tools/call', { name: 'get_status', arguments: {} }, { token: apiToken, protocol: '2025-11-25' });
    expect(r.status).toBe(401);
  });

  it('never accepts a token in the query string', async () => {
    const res = await fetch(`${h.mcp}?access_token=${sarah}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_status', arguments: {} } }),
    });
    expect(res.status).toBe(401);
  });

  it('serves Protected Resource Metadata that points at the issuer, and the issuer lists S256', async () => {
    const prm = await (await fetch(`${h.api}/.well-known/oauth-protected-resource`)).json();
    expect(prm.resource).toBe(h.mcp);
    expect(prm.authorization_servers[0]).toBe(h.issuer);
    const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
    expect(as.code_challenge_methods_supported).toContain('S256');
    expect(as.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
  });
});

describe('tool results', () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);

  const calls: [string, 'margaret' | 'sarah', Record<string, unknown>][] = [
    ['care_circle_help', 'sarah', {}],
    ['get_status', 'sarah', { person: 'Mom' }],
    ['get_week_summary', 'sarah', { days: 7 }],
    ['get_todays_doses', 'margaret', { part_of_day: 'all' }],
    ['check_in', 'margaret', { mood: 'good' }],
    ['log_dose', 'margaret', { medication_name: 'metformin', status: 'taken' }],
    ['message_circle', 'margaret', { message: 'Hello from the contract test' }],
    ['set_sharing', 'margaret', { paused: false }],
    ['join_circle', 'sarah', { code: '000000' }],
  ];

  it.each(calls)('%s is callable and follows the envelope', async (name, who, args) => {
    const client = await sdkClient(who === 'margaret' ? margaret : sarah);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name)!;
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    expect(content[0]?.type).toBe('text');
    const speech = content[0]!.text;
    expect(speech.length).toBeGreaterThan(0);
    expect(speech).not.toMatch(/[{}]|_id|dose_id|check_in|log_dose/);
    if (result.isError) {
      expect(content).toHaveLength(1);
    } else {
      const structured = result.structuredContent as { speech: string };
      expect(structured.speech).toBe(speech);
      expect(JSON.parse(content[1]!.text)).toEqual(structured);
      const validate = ajv.compile(tool.outputSchema!);
      expect(validate(structured), JSON.stringify(validate.errors)).toBe(true);
    }
    await client.close();
  });

  it('returns business errors as isError with a speakable message, not a protocol error', async () => {
    const r = await rpc(h, 'tools/call', { name: 'check_in', arguments: {} }, { token: sarah, protocol: '2025-11-25' });
    expect(r.status).toBe(200);
    expect(r.body.error).toBeUndefined();
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content).toEqual([
      { type: 'text', text: "That's for the person Care Circle looks after. You can ask how Margaret is doing instead." },
    ]);
  });

  it('answers invalid arguments with a speakable isError', async () => {
    const r = await rpc(h, 'tools/call', { name: 'check_in', arguments: { mood: 'ecstatic' } }, { token: margaret, protocol: '2025-11-25' });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).not.toMatch(/validation|enum|expected/i);
  });

  it('attaches the card metadata to get_status and get_todays_doses results', async () => {
    const r = await rpc(h, 'tools/call', { name: 'get_status', arguments: {} }, { token: sarah, protocol: '2025-11-25' });
    expect(r.body.result._meta.ui.resourceUri).toBe('ui://care-circle/today');
    expect(r.body.result.structuredContent.today.recipientName).toBe('Margaret');
  });
});
