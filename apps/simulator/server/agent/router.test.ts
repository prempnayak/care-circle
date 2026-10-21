import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MEDICAL_ADVICE_REPLY, route } from './router';

interface Case {
  say: string;
  tool: string | null;
  args?: Record<string, unknown>;
}
const cases = JSON.parse(readFileSync(new URL('../../../../tests/voice/utterances.json', import.meta.url), 'utf8')) as Case[];

function correct(c: Case): boolean {
  const r = route(c.say);
  if (c.tool === null) return r.kind === 'say' && r.text === MEDICAL_ADVICE_REPLY;
  if (r.kind !== 'tool' || r.name !== c.tool) return false;
  return Object.entries(c.args ?? {}).every(([k, v]) => r.args[k] === v);
}

describe('scripted router against tests/voice/utterances.json', () => {
  it('has 60 phrasings', () => expect(cases.length).toBe(60));

  it('routes at least 90% correctly (handoff §13.4 target)', () => {
    const misses = cases.filter((c) => !correct(c)).map((c) => `${c.say} → ${JSON.stringify(route(c.say))}`);
    const accuracy = (cases.length - misses.length) / cases.length;
    expect(accuracy, misses.join('\n')).toBeGreaterThanOrEqual(0.9);
  });

  it('keeps the whole message when the text has a curly apostrophe (macOS smart quotes)', () => {
    expect(route('Tell the family I’m going to the park')).toEqual({
      kind: 'tool',
      name: 'message_circle',
      args: { message: 'I’m going to the park' },
    });
    expect(route("Tell my family I'm going to the park")).toMatchObject({ args: { message: "I'm going to the park" } });
    expect(route('Let Sarah know I’ll be out at noon')).toMatchObject({ args: { message: 'I’ll be out at noon' } });
  });

  it('routes family messages both ways', () => {
    expect(route("Tell Mom I'll call at 6")).toEqual({ kind: 'tool', name: 'message_circle', args: { message: "I'll call at 6" } });
    for (const say of ['Any messages for me?', 'Do I have any messages', 'Read me my messages', 'Did anyone leave me a message?']) {
      expect(route(say), say).toMatchObject({ kind: 'tool', name: 'get_status' });
    }
  });

  it('handles yes/no for confirmations', () => {
    expect(route('Yes').kind).toBe('yes');
    expect(route('no thanks').kind).toBe('no');
  });

  it('sends crisis wording to check_in so the server redirects', () => {
    const r = route('Tell Care Circle I fell this morning');
    expect(r).toMatchObject({ kind: 'tool', name: 'check_in', args: { note: 'I fell this morning' } });
  });
});

describe('scripted router against tests/voice/crisis.json', () => {
  const crisis = JSON.parse(readFileSync(new URL('../../../../tests/voice/crisis.json', import.meta.url), 'utf8')) as {
    crisis: { text: string }[];
  };
  it.each(crisis.crisis)('routes "$text" to a tool that runs the crisis matcher', ({ text }) => {
    const r = route(text);
    expect(r.kind === 'tool' && ['check_in', 'message_circle'].includes(r.name)).toBe(true);
  });
});
