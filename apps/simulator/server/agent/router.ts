/**
 * Deterministic intent routing (SIM_AGENT=scripted, the default). No model: regexes map an utterance
 * to one tool and its arguments, so the whole demo runs locally without AWS.
 */
export type Route =
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'say'; text: string }
  | { kind: 'yes' }
  | { kind: 'no' };

type Part = 'morning' | 'afternoon' | 'evening';

export const MEDICAL_ADVICE_REPLY =
  "I can't give medical or dosing advice. Please ask your pharmacist or doctor about that.";
export const FALLBACK_REPLY = "Sorry, I didn't catch that. You can say 'check in', or ask what pills you have.";

const WAKE = /^(hey\s+)?alexa[,.!]?\s*/i;
const INVOCATION = /^(please\s+)?(tell|ask|open|use|have)\s+care\s*circle\s*(that\s+|to\s+|if\s+|whether\s+|about\s+)?/i;

export function clean(utterance: string): string {
  return utterance.trim().replace(WAKE, '').replace(INVOCATION, '').replace(/^care\s*circle[,:]?\s*/i, '').trim();
}

function partOfDay(t: string): Part | undefined {
  if (/\bmorning\b|\bbreakfast\b/.test(t)) return 'morning';
  if (/\bafternoon\b|\blunch\b|\bmidday\b|\bnoon\b/.test(t)) return 'afternoon';
  if (/\bevening\b|\bnight\b|\bbedtime\b|\bdinner\b|\btonight\b/.test(t)) return 'evening';
  return undefined;
}

function mood(t: string): 'good' | 'okay' | 'not_great' | undefined {
  if (/\b(not (feeling )?(so |too |very )?(good|great|well)|poorly|rough|unwell|awful|terrible|sick|bad day|lousy)\b/.test(t)) return 'not_great';
  if (/\b(a bit tired|tired|so-?so|alright|all right|not bad|ok|okay|fine-ish|could be better|meh)\b/.test(t)) return 'okay';
  if (/\b(great|good|fine|well|wonderful|fantastic|excellent|happy)\b/.test(t)) return 'good';
  return undefined;
}

const CRISIS_HINT =
  /\b(fell|fallen|fall|slipped|tripped|can'?t get up|hurt\w*|bleed\w*|chest|breath\w*|hit my head|stroke|die|dying|dead|kill\w*|suicid\w*|end my life|end it all|harm\w* myself|no reason to live)\b/;

/** Words that mean "the person's own statement for the family" rather than a command. */
function isStatementForFamily(t: string): boolean {
  return /^(i|i'm|im|i've|ive|my)\b/.test(t);
}

export function route(utterance: string): Route {
  const raw = clean(utterance);
  const t = raw.toLowerCase().replace(/[’]/g, "'");
  if (!t) return { kind: 'say', text: FALLBACK_REPLY };

  if (/^(yes|yeah|yep|yup|sure|correct|please do|do it|that's right|ok(ay)?,? yes|yes please)\b[.!]*$/.test(t)) return { kind: 'yes' };
  if (/^(no|nope|not now|cancel|never ?mind|stop)\b(,? thanks?| thank you)?[.!]*$/.test(t)) return { kind: 'no' };

  // Join code: "my code is 482159", "join with 482 159".
  const code = /\b(code|join)\b.*?((?:\d[\s-]?){6})/.exec(t);
  if (code) return { kind: 'tool', name: 'join_circle', args: { code: code[2]!.replace(/\D/g, '') } };

  // Medical or dosing questions: the Agent Skill says never advise; suggest a pharmacist or doctor.
  if (
    /\b(how (much|many)|what dose|dosage|should i (take|double|skip|stop)|can i take|is it (ok|okay|safe) to (take|mix|double)|side effects?|interact|overdose|double up)\b/.test(t)
  ) {
    return { kind: 'say', text: MEDICAL_ADVICE_REPLY };
  }

  if (/\b(what can you do|help|how does (this|it|care circle) work|what is care circle|what does care circle do)\b/.test(t)) {
    return { kind: 'tool', name: 'care_circle_help', args: {} };
  }

  if (/\b(pause|stop|turn off|hold)\b.*\bshar/.test(t) || /\b(some|a little|a bit of) privacy\b|\btake a break from sharing\b/.test(t)) {
    return { kind: 'tool', name: 'set_sharing', args: { paused: true } };
  }
  if (/\b(resume|restart|start|turn (back )?on|unpause)\b.*\bshar/.test(t) || /\bshar\w* (back on|again)\b/.test(t)) {
    return { kind: 'tool', name: 'set_sharing', args: { paused: false } };
  }

  if (/\b(week|weekly|last (few|couple of|\d+|seven|fourteen|two) (days|weeks)|fortnight|past (few )?days)\b/.test(t)) {
    const days = /\b(two weeks|fortnight|14|fourteen)\b/.test(t) ? 14 : 7;
    return { kind: 'tool', name: 'get_week_summary', args: { days } };
  }

  // Status: "how's Mom doing", "did Dad check in", "any news from Margaret", "how am I doing today", "any messages for me".
  if (
    /\b(how'?s|how is|how are|how am)\b.*\b(doing|today|going|getting on)\b/.test(t) ||
    /^how\b.*\bdoing\b/.test(t) ||
    /\bdid (?!i\b)(mom|dad|mum|grandma|grandpa|she|he|they|\w+) (check in|take|log)\b/.test(t) ||
    /\b(any news|status|update)\b/.test(t) ||
    /\b(any|my|new|read( me)?)\s+messages?\b|\bmessages? for me\b|\bdid (anyone|someone|the family) (leave|send)\b/.test(t)
  ) {
    const person = /\bhow'?s (\w+)|how is (\w+)|^how (\w+)|did (\w+)|from (\w+)/.exec(t);
    const who = person?.slice(1).find(Boolean);
    return { kind: 'tool', name: 'get_status', args: who && !['i', 'she', 'he', 'they', 'it'].includes(who) ? { person: who } : {} };
  }

  // Dose list: "what pills do I have this morning", "what's left", "what do I take tonight".
  if (
    /\bwhat\b.*\b(pills?|medicines?|medications?|meds|tablets?|left|take|list)\b/.test(t) ||
    /\b(which|any) (pills?|medicines?|meds)\b/.test(t) ||
    /\bdid i (take|have) my\b/.test(t)
  ) {
    return { kind: 'tool', name: 'get_todays_doses', args: { part_of_day: partOfDay(t) ?? 'all' } };
  }

  // Dose logging: "I took the metformin", "I had my blood pressure pill", "I skipped my evening pills".
  const dose =
    /\b(?:i\s+)?(?:just\s+)?(took|had|swallowed|taken|skipped|missed|forgot|didn'?t take|did not take|won'?t take|done with)\s+(?:my\s+|the\s+|all\s+(?:of\s+)?(?:my\s+)?)?(.+?)[.!]*$/.exec(t);
  if (dose && !CRISIS_HINT.test(t)) {
    const status = /skipped|missed|forgot|didn'?t|did not|won'?t/.test(dose[1]!) ? 'skipped' : 'taken';
    const what = dose[2]!.trim();
    const part = partOfDay(what);
    if (/^(morning|afternoon|evening|night|bedtime|lunchtime)?\s*(pills?|medicines?|meds|tablets?|medications?)\b/.test(what) || /^pills?$/.test(what)) {
      return { kind: 'tool', name: 'log_dose', args: { part_of_day: part ?? 'morning', status } };
    }
    return { kind: 'tool', name: 'log_dose', args: { medication_name: what.replace(/\b(this|in the) (morning|afternoon|evening)\b/, '').trim(), status, ...(part ? { part_of_day: part } : {}) } };
  }

  // Messages: "tell my family I need groceries", "send a message to my kids saying …", "let Sarah know I'll be out".
  const msg =
    /^(?:please\s+)?(?:tell|message|text|let)\s+(?:my\s+|the\s+|our\s+)?(family|kids|children|daughter|son|sarah|tom|everyone|them|\w+)\s+(?:know\s+)?(?:that\s+)?(.+)$/.exec(t) ??
    /^(?:send|leave)\s+(?:a\s+)?(?:message|note)\s+(?:to\s+(?:my\s+)?\w+\s+)?(?:saying\s+|that\s+)?(.+)$/.exec(t);
  if (msg) {
    const body = (msg[2] ?? msg[1])!.trim();
    // "tell my family I'm okay" is a check-in, not a message.
    if (/^i'?m (up|ok|okay|fine|awake|alright|good)\b/.test(body)) {
      const m = mood(body);
      return { kind: 'tool', name: 'check_in', args: m ? { mood: m } : {} };
    }
    // `t` is `raw` lowercased with curly apostrophes straightened (same length), so find the body in `t`.
    return { kind: 'tool', name: 'message_circle', args: { message: raw.slice(t.lastIndexOf(body)).slice(0, 140) } };
  }

  // Check-in: "I'm up", "good morning", "check in", "I'm awake. A bit tired today."
  if (/\b(i'?m up|i am up|good morning|morning,|check(ing)? in|i'?m awake|i am awake|i'?m (ok|okay|fine|alright)|up and about|just woke up|i'?m here)\b/.test(t)) {
    const m = mood(t);
    const rest = raw.replace(/^[^.!?]*[.!?]\s*/, '').trim();
    const note = rest && rest !== raw ? rest.slice(0, 140) : undefined;
    return { kind: 'tool', name: 'check_in', args: { ...(m ? { mood: m } : {}), ...(note ? { note } : {}) } };
  }

  // Anything else the person says about themselves (including crisis wording) becomes a check-in note,
  // so the server's deterministic crisis matcher sees it.
  if (isStatementForFamily(t) || CRISIS_HINT.test(t)) {
    const m = mood(t);
    return { kind: 'tool', name: 'check_in', args: { note: raw.slice(0, 140), ...(m ? { mood: m } : {}) } };
  }

  return { kind: 'say', text: FALLBACK_REPLY };
}
