import { describe, expect, it } from 'vitest';
import { allEmailSamples, allSpeechSamples, copy, EMERGENCY_FOOTER, listNames, MEDICAL_DISCLAIMER } from './copy';

/** Banned in product copy (handoff §4.3.1), plus the honest-verb rules (§3.5). */
const BANNED: RegExp[] = [
  /\bmonitor(s|ing|ed)?\b/i,
  /\bkeeps?\b[^.]{0,40}\bsafe\b/i,
  /\bdetects? falls?\b/i,
  /(?<!not an |isn't an )\bemergency service\b/i,
  /\btook\b/i,
  /\bis unwell\b/i,
  /\bis missing\b/i,
  /\bnotified\b/i,
  /\b(check_in|log_dose|get_status|join_circle|message_circle|set_sharing|get_week_summary|get_todays_doses|care_circle_help)\b/,
  /\bdose_?id\b/i,
  /[{}[\]]/,
];

function sentences(s: string): number {
  // Split on sentence-ending punctuation followed by a space and a capital letter or end of string.
  return s
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .filter(Boolean).length;
}

describe('copy lint', () => {
  const speech = allSpeechSamples();

  it.each(speech)('speech has at most 2 sentences: %s', (s) => {
    expect(sentences(s)).toBeLessThanOrEqual(2);
  });

  it.each(speech)('speech avoids banned words: %s', (s) => {
    for (const re of BANNED) expect(s).not.toMatch(re);
  });

  it('speech stays short enough to say in under 30 seconds (~75 words)', () => {
    for (const s of speech) expect(s.split(/\s+/).length).toBeLessThanOrEqual(75);
  });

  it.each(allEmailSamples())('email avoids banned words: $subject', (e) => {
    for (const re of BANNED) {
      expect(e.subject).not.toMatch(re);
      expect(e.text).not.toMatch(re);
    }
  });

  it('footer and disclaimer carry the required wording', () => {
    expect(EMERGENCY_FOOTER).toBe('Care Circle is not an emergency service. In an emergency, call 911.');
    expect(MEDICAL_DISCLAIMER).toContain('not a substitute for professional medical advice');
  });

  it('lists at most 5 names aloud', () => {
    expect(listNames(['a'])).toBe('a');
    expect(listNames(['a', 'b'])).toBe('a and b');
    expect(listNames(['a', 'b', 'c'])).toBe('a, b and c');
    expect(listNames(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e and two more');
  });
});

describe('medicine counts read naturally', () => {
  it('says "both" for two, never "all two"', () => {
    expect(copy.statusDoses(2, 2, [])).toBe('Both medicines today are logged.');
    expect(copy.dosesAllLogged(2, 'this morning')).toBe('Both of your medicines for this morning are logged.');
    expect(copy.statusDoses(3, 3, [])).toBe('All three medicines today are logged.');
    expect(copy.statusDoses(1, 1, [])).toBe('The one medicine today is logged.');
  });
});
