import { describe, expect, it } from 'vitest';
import { NeedsLinking, type Connection } from '../mcp';
import type { PersonaState, TraceEntry } from '../types';
import type { MessageData } from '@strands-agents/sdk';
import { contextFor, crisisCheckIn, repairArgs, describeModel, modelFromEnv, StrandsAgentImpl } from './strands';

describe('modelFromEnv', () => {
  it('defaults to Qwen 3 8B on the local LM Studio server', () => {
    expect(modelFromEnv({})).toEqual({ provider: 'lmstudio', modelId: 'qwen/qwen3-8b', baseUrl: 'http://localhost:1234/v1' });
  });

  it('switches to Bedrock with one setting, and needs a model id there', () => {
    expect(modelFromEnv({ SIM_MODEL_PROVIDER: 'bedrock', SIM_MODEL_ID: 'us.anthropic.claude-haiku-5-5', AWS_REGION: 'us-east-1' })).toEqual({
      provider: 'bedrock',
      modelId: 'us.anthropic.claude-haiku-5-5',
      region: 'us-east-1',
    });
    expect(modelFromEnv({ SIM_MODEL_PROVIDER: 'bedrock', BEDROCK_MODEL_ID: 'us.amazon.nova-2-lite-v1:0' }).modelId).toBe('us.amazon.nova-2-lite-v1:0');
    expect(() => modelFromEnv({ SIM_MODEL_PROVIDER: 'bedrock' })).toThrow(/SIM_MODEL_ID/);
  });

  it('names the model for the trace and the header', () => {
    expect(describeModel(modelFromEnv({}))).toBe('qwen/qwen3-8b via LM Studio');
  });
});

describe('crisis safety net', () => {
  it('sends injury and self-harm wording straight to check_in with her own words', () => {
    expect(crisisCheckIn('Alexa, tell Care Circle I fell in the bathroom')).toEqual({ name: 'check_in', args: { note: 'I fell in the bathroom' } });
    expect(crisisCheckIn('I have chest pain')).toEqual({ name: 'check_in', args: { note: 'I have chest pain' } });
    expect(crisisCheckIn("There's no reason to live anymore")?.name).toBe('check_in');
  });

  it('leaves near-misses to the model', () => {
    expect(crisisCheckIn('The leaves fell off the tree')).toBeNull();
    expect(crisisCheckIn("I'm up, a bit tired today")).toBeNull();
  });

  it('keeps the note within 140 characters', () => {
    expect(crisisCheckIn(`I fell ${'and it was a long story '.repeat(10)}`)!.args.note.length).toBe(140);
  });
});

function fakeConnection(calls: { name: string; args: Record<string, unknown> }[], status = 200): Connection {
  return {
    tools: [],
    async call(name, args) {
      calls.push({ name, args });
      if (status === 401) throw new NeedsLinking();
      const speech = 'Please call 911 now if you are hurt. I am letting Sarah and Tom know.';
      return { name, args, status, isError: false, speech, structuredContent: { speech, crisis: 'injury' }, raw: { content: [{ type: 'text', text: speech }] } };
    },
    readResource: async () => '',
    close: async () => {},
  };
}

describe('StrandsAgentImpl.respond (safety-net path, no model call)', () => {
  // A model that can't be reached: these turns must never need it.
  const agent = new StrandsAgentImpl({ provider: 'lmstudio', modelId: 'unused', baseUrl: 'http://127.0.0.1:9/v1' });

  it("calls check_in, speaks Care Circle's reply and remembers the turn", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const persona: PersonaState = { id: 'margaret', history: [] };
    const trace: TraceEntry[] = [];
    const out = await agent.respond({ persona, trace, now: new Date(), connect: async () => fakeConnection(calls) }, 'I fell this morning');
    expect(calls).toEqual([{ name: 'check_in', args: { note: 'I fell this morning' } }]);
    expect(out.reply).toMatch(/^Please call 911/);
    expect(out.toolCalls).toHaveLength(1);
    expect(trace.some((t) => t.label.includes('safety net'))).toBe(true);
    // user text, tool use, tool result, assistant text: a valid history for the next turn
    expect((persona.history as { role: string }[]).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('turns a 401 into account linking, as Alexa does', async () => {
    const persona: PersonaState = { id: 'new', history: [] };
    await expect(
      agent.respond({ persona, trace: [], now: new Date(), connect: async () => fakeConnection([], 401) }, 'I fell this morning'),
    ).rejects.toBeInstanceOf(NeedsLinking);
  });

  it('routes crisis wording without asking the model', async () => {
    expect(await agent.routeOnly('I want to end my life', [])).toEqual({ name: 'check_in', args: { note: 'I want to end my life' } });
  });
});

describe('contextFor', () => {
  const turn = (said: string, reply: string, tool?: string): MessageData[] => [
    { role: 'user', content: [{ text: said }] },
    ...(tool
      ? ([
          { role: 'assistant', content: [{ toolUse: { name: tool, toolUseId: 't1', input: {} } }] },
          { role: 'user', content: [{ toolResult: { toolUseId: 't1', status: 'success', content: [{ text: reply }] } }] },
        ] as MessageData[])
      : []),
    { role: 'assistant', content: [{ text: reply }] },
  ];

  it('gives the model no history after a plain answer, so it asks Care Circle again', () => {
    expect(contextFor([...turn('what pills do I have', 'Both medicines today are logged.', 'get_todays_doses')])).toEqual([]);
  });

  it('keeps only the last exchange when Alexa asked a question', () => {
    const history = [...turn("I'm up", 'Thanks, Margaret.', 'check_in'), ...turn('what pills do I have', 'One still open: metformin at 8. Want to log it?', 'get_todays_doses')];
    const ctx = contextFor(history);
    expect(ctx).toHaveLength(4);
    expect(ctx[0]).toEqual({ role: 'user', content: [{ text: 'what pills do I have' }] });
  });

  it('is empty for a new conversation', () => {
    expect(contextFor([])).toEqual([]);
  });
});

describe('repairArgs', () => {
  it('treats a log_dose without a status as taken', () => {
    expect(repairArgs('log_dose', { part_of_day: 'morning', confirm: true })).toEqual({ part_of_day: 'morning', confirm: true, status: 'taken' });
  });
  it('keeps an explicit status and leaves other tools alone', () => {
    expect(repairArgs('log_dose', { medication_name: 'lisinopril', status: 'skipped' }).status).toBe('skipped');
    expect(repairArgs('check_in', { mood: 'good' })).toEqual({ mood: 'good' });
  });
});
