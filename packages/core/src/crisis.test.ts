import { describe, expect, it } from 'vitest';
import { matchCrisis, normalize } from './crisis';

describe('crisis matcher', () => {
  it('normalizes punctuation, curly quotes and contractions', () => {
    expect(normalize('I CAN’T   breathe!!')).toBe("i can't breathe");
    expect(normalize('I cannot get up')).toBe("i can't get up");
  });

  it('returns null for empty input', () => {
    expect(matchCrisis(undefined).category).toBeNull();
    expect(matchCrisis('').category).toBeNull();
  });

  it('prefers self_harm when both appear', () => {
    expect(matchCrisis('I fell and I want to die').category).toBe('self_harm');
  });

  it('treats "hurt myself" as injury but "on purpose" as self_harm', () => {
    expect(matchCrisis('I hurt myself').category).toBe('injury');
    expect(matchCrisis('I hurt myself on purpose').category).toBe('self_harm');
  });

  it.each(['fell asleep', 'the leaves fell', 'fall is my favorite season', 'breathing exercises', 'a stroke of luck'])(
    'spec near-miss "%s" does not match',
    (t) => expect(matchCrisis(t).category).toBeNull(),
  );
});
