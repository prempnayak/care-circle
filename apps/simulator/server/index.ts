/**
 * Simulator agent backend: stands in for the Alexa+ cloud. It runs the agent (scripted or Bedrock),
 * calls Care Circle through the MCP client SDK with each persona's own token, and does Alexa-style
 * account linking when a tool call comes back 401. AWS credentials and the dev key stay here.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { BedrockAgent } from './agent/bedrock';
import { ScriptedAgent } from './agent/scripted';
import type { Agent } from './agent/types';
import { Linker } from './linking';
import { connect, NeedsLinking } from './mcp';
import type { PersonaState, Tokens, TraceEntry, TurnResult } from './types';

export const PERSONAS = [
  { id: 'margaret', label: 'Margaret', hint: 'Margaret, 78 — the person Care Circle looks after' },
  { id: 'sarah', label: 'Sarah', hint: 'Sarah, daughter — lead caregiver' },
  { id: 'tom', label: 'Tom', hint: 'Tom, son — family member' },
  { id: 'new', label: 'New user', hint: 'Someone who has not joined yet' },
] as const;

export interface SimulatorOptions {
  mcpUrl: string;
  agentPort: number;
  /** Public URL of this backend (for the OAuth redirect URI); defaults to http://localhost:<agentPort>. */
  publicUrl?: string;
  uiOrigin: string;
  agentMode: 'scripted' | 'bedrock';
  bedrockModelId?: string;
  region?: string;
  devKey?: string;
  devEndpoints: boolean;
  /** Persist linked tokens across restarts (gitignored file). */
  tokenFile?: string;
  log?: (msg: string) => void;
}

const LINK_PROMPT = 'To use that, link your Care Circle account. Use the link button on the screen.';

export function createSimulatorApp(opts: SimulatorOptions) {
  const log = opts.log ?? (() => {});
  const apiOrigin = new URL(opts.mcpUrl).origin;
  const publicUrl = (opts.publicUrl ?? `http://localhost:${opts.agentPort}`).replace(/\/$/, '');
  const linker = new Linker(opts.mcpUrl, process.env.SIM_CLIENT_ID ?? 'simulator', `${publicUrl}/link/callback`);
  const agent: Agent =
    opts.agentMode === 'bedrock' && opts.bedrockModelId ? new BedrockAgent(opts.bedrockModelId, opts.region) : new ScriptedAgent();
  if (opts.agentMode === 'bedrock' && !opts.bedrockModelId) log('SIM_AGENT=bedrock but BEDROCK_MODEL_ID is empty; using the scripted agent.');

  const personas = new Map<string, PersonaState>();
  const pendingTrace = new Map<string, TraceEntry[]>();
  const lastUtterance = new Map<string, string>();

  if (opts.tokenFile && existsSync(opts.tokenFile)) {
    const saved = JSON.parse(readFileSync(opts.tokenFile, 'utf8')) as Record<string, Tokens>;
    for (const [id, tokens] of Object.entries(saved)) personas.set(id, { id, tokens, history: [] });
  }
  const persist = () => {
    if (!opts.tokenFile) return;
    const out: Record<string, Tokens> = {};
    for (const [id, p] of personas) if (p.tokens) out[id] = p.tokens;
    writeFileSync(opts.tokenFile, JSON.stringify(out, null, 2), { mode: 0o600 });
  };
  const state = (id: string): PersonaState => {
    let p = personas.get(id);
    if (!p) {
      p = { id, history: [] };
      personas.set(id, p);
    }
    return p;
  };

  const app = new Hono();
  app.use('*', cors({ origin: [opts.uiOrigin], allowMethods: ['GET', 'POST', 'OPTIONS'] }));

  app.get('/config', (c) =>
    c.json({ agent: agent.name, devControls: opts.devEndpoints && Boolean(opts.devKey), personas: PERSONAS, mcpUrl: opts.mcpUrl }),
  );

  app.get('/personas', (c) =>
    c.json(PERSONAS.map((p) => ({ ...p, linked: Boolean(personas.get(p.id)?.tokens) }))),
  );

  app.post('/turn', async (c) => {
    const { persona: id, text, retry } = (await c.req.json()) as { persona: string; text?: string; retry?: boolean };
    if (!PERSONAS.some((p) => p.id === id)) return c.json({ error: 'unknown persona' }, 400);
    const utterance = retry ? lastUtterance.get(id) : text;
    if (!utterance || utterance.length > 500) return c.json({ error: 'say something' }, 400);
    lastUtterance.set(id, utterance);

    const persona = state(id);
    const trace: TraceEntry[] = [...(pendingTrace.get(id) ?? [])];
    pendingTrace.delete(id);
    trace.push({ at: new Date().toISOString(), kind: 'agent', label: `${id}: “${utterance}”` });

    // Refresh an expired access token first, as Alexa does.
    if (persona.tokens && persona.tokens.expiresAt - 30_000 < Date.now()) {
      persona.tokens = (await linker.refresh(persona.tokens, trace)) ?? undefined;
      persist();
    }

    const result: TurnResult = { reply: '', toolCalls: [], trace };
    try {
      const out = await agent.respond(
        { persona, trace, now: new Date(), connect: () => connect(opts.mcpUrl, persona.tokens?.accessToken, trace) },
        utterance,
      );
      result.reply = out.reply;
      result.toolCalls = out.toolCalls;
      const withCard = [...out.toolCalls].reverse().find((t) => t.cardUri && !t.isError && t.structuredContent);
      if (withCard) {
        result.card = {
          toolName: withCard.name,
          structuredContent: withCard.structuredContent!,
          resourceUri: withCard.cardUri!,
          toolResult: (withCard as { raw?: unknown }).raw ?? { structuredContent: withCard.structuredContent },
        };
      }
    } catch (err) {
      if (err instanceof NeedsLinking) {
        // 401 with no WWW-Authenticate: discover and start linking, then the UI retries the utterance.
        persona.tokens = undefined;
        persist();
        try {
          result.needsLinking = await linker.start(id, trace);
          result.reply = LINK_PROMPT;
        } catch (linkErr) {
          trace.push({ at: new Date().toISOString(), kind: 'oauth', label: `linking discovery failed: ${(linkErr as Error).message}` });
          result.reply = "I couldn't reach Care Circle just now. Try again in a minute.";
        }
      } else {
        log(`turn failed: ${(err as Error).message}`);
        trace.push({ at: new Date().toISOString(), kind: 'agent', label: `error: ${(err as Error).message}` });
        result.reply = "I couldn't reach Care Circle just now. Try again in a minute.";
      }
    }
    // Strip the raw tool results from the toolCalls list (the card keeps what it needs).
    result.toolCalls = result.toolCalls.map(({ ...t }) => {
      delete (t as { raw?: unknown }).raw;
      return t;
    });
    return c.json(result);
  });

  app.get('/link/start', async (c) => {
    const id = c.req.query('persona') ?? '';
    if (!PERSONAS.some((p) => p.id === id)) return c.text('unknown persona', 400);
    const trace: TraceEntry[] = [];
    const { authorizeUrl } = await linker.start(id, trace);
    pendingTrace.set(id, [...(pendingTrace.get(id) ?? []), ...trace]);
    return c.redirect(authorizeUrl, 302);
  });

  app.get('/link/callback', async (c) => {
    const code = c.req.query('code');
    const st = c.req.query('state');
    const page = (body: string, persona = '') =>
      c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Account linking</title></head>
<body style="font-family:system-ui;font-size:22px;padding:24px"><p>${body}</p>
<script>try{window.opener&&window.opener.postMessage({type:'care-circle-linked',persona:${JSON.stringify(persona)}},${JSON.stringify(opts.uiOrigin)});}catch(e){}setTimeout(function(){window.close()},800);</script></body></html>`);
    if (!code || !st) return page('Linking was cancelled.');
    const trace: TraceEntry[] = [];
    try {
      const { persona, tokens } = await linker.finish(code, st, trace);
      state(persona).tokens = tokens;
      state(persona).history = [];
      persist();
      pendingTrace.set(persona, [...(pendingTrace.get(persona) ?? []), ...trace]);
      return page('Your account is linked. You can close this window.', persona);
    } catch (err) {
      return page(`Linking failed: ${(err as Error).message}`);
    }
  });

  app.post('/unlink', async (c) => {
    const { persona } = (await c.req.json()) as { persona: string };
    const p = personas.get(persona);
    if (p) {
      p.tokens = undefined;
      p.pending = undefined;
      p.history = [];
    }
    persist();
    return c.json({ ok: true });
  });

  let cardCache: { html: string; at: number } | null = null;
  app.get('/card', async (c) => {
    if (!cardCache || Date.now() - cardCache.at > 10_000) {
      const conn = await connect(opts.mcpUrl, undefined, []);
      try {
        cardCache = { html: await conn.readResource('ui://care-circle/today'), at: Date.now() };
      } finally {
        await conn.close();
      }
    }
    return c.html(cardCache.html);
  });

  // Demo controls: proxied so the dev key never reaches the browser.
  app.all('/dev/:action', async (c) => {
    if (!opts.devEndpoints || !opts.devKey) return c.json({ error: 'dev controls are off' }, 404);
    const action = c.req.param('action');
    if (!['clock', 'sweep', 'reset', 'seed'].includes(action)) return c.json({ error: 'unknown' }, 404);
    const query = new URL(c.req.url).search;
    const res = await fetch(`${apiOrigin}/dev/${action}${query}`, {
      method: c.req.method,
      headers: { 'x-dev-key': opts.devKey, 'content-type': 'application/json' },
      ...(c.req.method === 'POST' ? { body: (await c.req.text()) || '{}' } : {}),
    });
    if (action === 'reset') for (const p of personas.values()) p.pending = undefined;
    return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
  });

  return app;
}
