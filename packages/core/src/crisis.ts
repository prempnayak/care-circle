/**
 * Deterministic crisis-wording matcher.
 *
 * This is a courtesy redirect, not detection: it looks for a short list of phrases so Care Circle
 * can say "call 911" (or "call or text 988") first and then email the family. It never judges severity.
 * Near-misses ("fell asleep", "stroke of luck", "breathing exercises") are covered by tests/voice/crisis.json.
 */
export type CrisisCategory = 'injury' | 'self_harm';

export interface CrisisMatch {
  category: CrisisCategory | null;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\bcan ?not\b/g, "can't")
    .replace(/\bcant\b/g, "can't")
    .replace(/\bim\b/g, "i'm")
    .replace(/\bive\b/g, "i've")
    .replace(/\s+/g, ' ')
    .trim();
}

const SELF_HARM: RegExp[] = [
  /\b(want|wanna|going|wish i|wish to|ready) (to )?die\b/,
  /\bwant to be dead\b/,
  /\bkill(ing)? myself\b/,
  /\bend(ing)? (my life|it all)\b/,
  /\bsuicid(e|al)\b/,
  /\b(hurt|harm|cut)(ing)? myself on purpose\b/,
  /\bharm(ing)? myself\b/,
  /\bno (reason|point) (to|in) (live|living|go on|going on)\b/,
  /\bbetter off dead\b/,
  /\bdon't want to (live|be alive|wake up)\b/,
];

// "fell" only counts when a person is the subject and it isn't "fell asleep", "fell behind", etc.
const FELL_NOT = String.raw`(?! (asleep|behind|in love|for (it|that|a)|apart|through|short|silent|quiet|ill\b))`;

const INJURY: RegExp[] = [
  new RegExp(String.raw`\b(i|i've|i have|i just|i nearly|i almost|i think i) ?(just )?(fell|fallen|slipped|tripped)\b` + FELL_NOT),
  /\b(had|took|have had) a (bad |little |nasty )?(fall|tumble)\b/,
  /\b(fell|fallen) (down the stairs|out of bed|on the floor|in the (bath|tub|shower|kitchen|bathroom|garden|yard))\b/,
  /\bon the floor and can't\b/,
  /\bcan't get up\b/,
  /\bhurt myself\b(?! on purpose)/,
  /\bi'?m (hurt|injured|bleeding)\b/,
  /\bbleeding\b/,
  /\bchest (pain|pains|hurts|is tight|tightness)\b/,
  /\bpain in my chest\b/,
  /\bcan't (breathe|catch my breath)\b/,
  /\b(trouble|difficulty|hard time|struggling) breathing\b/,
  /\bhard to breathe\b/,
  /\bhit my head\b/,
  /\b(having|had|think i'?m having|think i had|a) stroke\b(?! of)/,
  /\bbroke(n)? my (hip|leg|arm|wrist|ankle)\b/,
];

export function matchCrisis(text: string | undefined | null): CrisisMatch {
  if (!text) return { category: null };
  const t = normalize(text);
  if (SELF_HARM.some((re) => re.test(t))) return { category: 'self_harm' };
  if (INJURY.some((re) => re.test(t))) return { category: 'injury' };
  return { category: null };
}
