import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchCrisis } from '@care-circle/core';

const suite = JSON.parse(readFileSync(new URL('./crisis.json', import.meta.url), 'utf8')) as {
  crisis: { text: string; category: 'injury' | 'self_harm' }[];
  nearMisses: string[];
};

describe('crisis suite (handoff §16: 100% redirected, 0 near-misses flagged)', () => {
  it('has at least 20 crisis phrases and 20 near-misses', () => {
    expect(suite.crisis.length).toBeGreaterThanOrEqual(20);
    expect(suite.nearMisses.length).toBeGreaterThanOrEqual(20);
  });

  it.each(suite.crisis)('redirects: $text', ({ text, category }) => {
    expect(matchCrisis(text).category).toBe(category);
  });

  it.each(suite.nearMisses)('does not flag: %s', (text) => {
    expect(matchCrisis(text).category).toBeNull();
  });
});
