/**
 * Every user-facing string lives here. tests in copy.test.ts scan them for banned words and length.
 *
 * Rules (handoff §3.5): at most 2 sentences; "logged" not "took"; "hasn't checked in" not "is unwell";
 * "shared with" unless an email really goes out; no tool names, IDs or codes; one next step per error.
 * Copy names the person instead of using pronouns, because we don't know anyone's pronouns.
 */
import type { CrisisCategory } from './crisis';
import type { Mood, Role } from './types';

/** Keep mood behind one switch so it can move to the dashboard only (handoff §19). */
export const SPEAK_MOOD_TO_CAREGIVERS = true;

export const EMERGENCY_FOOTER = 'Care Circle is not an emergency service. In an emergency, call 911.';
export const MEDICAL_DISCLAIMER =
  'This is not a substitute for professional medical advice. Consult a healthcare provider for personal medical decisions.';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Sarah", "Sarah and Tom", "Sarah, Tom and Priya"; at most 5 names are spoken. */
export function listNames(names: string[], max = 5): string {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  if (extra > 0) shown.push(`${numberWord(extra)} more`);
  if (shown.length <= 1) return shown[0] ?? '';
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

export function moodPhrase(mood: Mood): string {
  if (mood === 'good') return 'feeling good';
  if (mood === 'okay') return 'feeling okay';
  return 'not feeling great';
}

export const copy = {
  // ---- generic errors ----
  unavailable: () => "I couldn't reach Care Circle just now. Try again in a minute.",
  notMember: () => "You're not in a Care Circle yet. Ask your family for a join code.",
  recipientOnly: (recipientName: string) =>
    `That's for the person Care Circle looks after. You can ask how ${recipientName} is doing instead.`,
  caregiverOnly: () => "That's for family members. You can ask how you're doing today instead.",
  badInput: () => "I didn't catch that. Could you say it again?",
  tooLong: () => 'That was a bit long for Care Circle. Please say it in a shorter way.',

  // ---- care_circle_help ----
  helpAnonymous: () =>
    "Care Circle lets you check in with your family and keep a simple log of your medicines. It isn't for emergencies; if you need help now, call 911.",
  helpNoCircle: () =>
    "Care Circle lets your family share check-ins and a simple medicine log; to join, ask your family for a join code. It isn't for emergencies; if you need help now, call 911.",
  helpRecipient: () =>
    "You can say 'I'm up' to check in, ask what pills you have, or tell me when you've had one. Care Circle isn't for emergencies; if you need help now, call 911.",
  helpCaregiver: (recipientName: string) =>
    `You can ask how ${recipientName} is doing today or how the week went. Care Circle isn't for emergencies; if ${recipientName} needs help now, call 911.`,

  // ---- join_circle ----
  joinCodeNotFound: () => "I couldn't find that code. Check the six digits on your family's dashboard and try again.",
  joinLocked: () => "Too many codes didn't match. Please wait an hour, then try again.",
  joinAlreadyMember: () => "You're already in a Care Circle. Say 'help' to hear what you can do.",
  joinRecipientTaken: () =>
    'That circle already has someone Care Circle looks after. Ask your family for a family member code instead.',
  joinReadBackRecipient: (recipientName: string, caregivers: string[]) =>
    caregivers.length > 0
      ? `This shares your check-ins, mood and medicine log with ${listNames(caregivers)}. Say yes to join ${recipientName}'s circle.`
      : `This shares your check-ins, mood and medicine log with the family members in ${recipientName}'s circle. Say yes to join.`,
  joinReadBackMember: (recipientName: string) =>
    `You'll be able to ask how ${recipientName} is doing and get Care Circle emails about ${recipientName}. Say yes to join ${recipientName}'s circle.`,
  joinedRecipient: () => "You've joined. Say 'check in' any morning to let your family know you're up.",
  joinedMember: (recipientName: string) => `You've joined ${recipientName}'s circle. Ask how ${recipientName} is doing any time.`,

  // ---- check_in ----
  checkInShared: (name: string, at: string, caregivers: string[]) =>
    caregivers.length > 0
      ? `Thanks, ${name}. Your check-in at ${at} is shared with ${listNames(caregivers)}.`
      : `Thanks, ${name}. Your check-in at ${at} is saved.`,
  checkInPaused: (name: string, at: string) =>
    `Thanks, ${name}. Your check-in at ${at} is saved and stays private while sharing is paused.`,

  // ---- crisis redirect (always spoken first) ----
  crisisRedirect: (category: CrisisCategory) =>
    category === 'injury'
      ? "If you're hurt or need help now, call 911."
      : "If you're thinking about harming yourself, please call or text 988 to reach the Suicide and Crisis Lifeline, or call 911 if you're in danger.",
  crisisCheckIn: (category: CrisisCategory, name: string, caregivers: string[], paused: boolean) => {
    const redirect =
      category === 'injury'
        ? `I'm sorry, ${name}; if you're hurt or need help now, call 911.`
        : copy.crisisRedirect('self_harm');
    if (paused) return `${redirect} Sharing is paused, so your family hasn't been told.`;
    if (caregivers.length === 0) return `${redirect} There's no one else in your circle yet.`;
    return `${redirect} I'm letting ${listNames(caregivers)} know.`;
  },

  // ---- get_todays_doses ----
  dosesNone: (scope: string) => `You don't have any medicines listed for ${scope}. Your family can add them on the dashboard.`,
  dosesAllLogged: (count: number, scope: string) =>
    count === 1 ? `Your one medicine for ${scope} is logged.` : `All ${numberWord(count)} of your medicines for ${scope} are logged.`,
  dosesList: (openItems: string[], openCount: number, loggedCount: number) => {
    const head = `${capitalize(numberWord(openCount))}${loggedCount > 0 ? ' still open' : ''}: ${listNames(openItems)}.`;
    return `${head} Want to log ${openCount === 1 ? 'it' : 'them'}?`;
  },

  // ---- log_dose ----
  doseNotFound: () => "I couldn't find that medicine for today. Say 'what pills do I have' to hear the list.",
  doseWhich: (options: string[]) => `Which one did you mean: ${options.join(' or ')}?`,
  doseNeedName: () => "Which medicine did you mean? You can say its name, like 'my morning pill'.",
  doseAlreadyLogged: (name: string, scope: string) => `${capitalize(name)} is already logged for ${scope}.`,
  doseNothingOpen: (scope: string) => `There's nothing left to log for ${scope}. Say 'what pills do I have' to hear today's list.`,
  doseBulkReadBack: (names: string[], scope: string, status: 'taken' | 'skipped') =>
    `That's ${listNames(names)} for ${scope}. Say yes to log ${names.length === 1 ? 'it' : 'them'} as ${status}.`,
  doseLogged: (names: string[], status: 'taken' | 'skipped', at: string, stillOpen: string[]) => {
    const first = `Logged ${listNames(names)} as ${status} at ${at}.`;
    if (stillOpen.length === 0) return `${first} That's everything open for today.`;
    if (stillOpen.length === 1) return `${first} ${capitalize(stillOpen[0]!)} is still open.`;
    return `${first} ${capitalize(listNames(stillOpen))} are still open.`;
  },

  // ---- message_circle ----
  messageSending: (caregivers: string[]) => `I'm sending that to ${listNames(caregivers)}.`,
  messageNoOne: () => "There's no one else in your circle yet, so I couldn't send that. Ask your family to join with a code.",
  messageCrisis: (category: CrisisCategory, caregivers: string[]) =>
    caregivers.length > 0
      ? `${copy.crisisRedirect(category)} I'm sending your message to ${listNames(caregivers)}.`
      : `${copy.crisisRedirect(category)} There's no one else in your circle yet.`,

  // ---- get_status ----
  statusPaused: (name: string) => `${name} has paused sharing. You can still reach ${name} directly.`,
  statusNotYet: (name: string, windowEnd: string) =>
    `${name} hasn't checked in yet today; the check-in window runs until ${windowEnd}.`,
  statusMissed: (name: string, windowEnd: string) => `${name} hasn't checked in today; the check-in window ended at ${windowEnd}.`,
  statusCheckedIn: (name: string, at: string, mood: Mood | undefined, hasNote: boolean) => {
    const parts = [`${name} checked in at ${at}`];
    if (mood && SPEAK_MOOD_TO_CAREGIVERS) parts.push(moodPhrase(mood));
    let s = parts.join(', ');
    if (hasNote) s += ', and left a note on your dashboard';
    return `${s}.`;
  },
  statusSelfCheckedIn: (at: string) => `You checked in at ${at}.`,
  statusSelfNotYet: (windowEnd: string) => `You haven't checked in yet today; your window runs until ${windowEnd}.`,
  statusDoses: (logged: number, total: number, openNames: string[]) => {
    if (total === 0) return '';
    if (logged === total) return total === 1 ? 'The one medicine today is logged.' : `All ${numberWord(total)} medicines today are logged.`;
    if (logged === 0) {
      if (openNames.length > 0 && openNames.length <= 2) return `No medicines are logged yet today; ${listNames(openNames)} ${openNames.length === 1 ? 'is' : 'are'} still open.`;
      return `None of today's ${numberWord(total)} medicines are logged yet.`;
    }
    const head = `${capitalize(numberWord(logged))} of ${numberWord(total)} medicines today ${logged === 1 ? 'is' : 'are'} logged`;
    if (openNames.length === 0) return `${head}.`;
    if (openNames.length <= 2) return `${head}; ${listNames(openNames)} ${openNames.length === 1 ? 'is' : 'are'} still open.`;
    return `${head}; ${numberWord(openNames.length)} are still open.`;
  },

  // ---- get_week_summary ----
  weekSummary: (name: string, checkInDays: number, expectedDays: number, logged: number, scheduled: number) => {
    const ci = `${name} checked in ${checkInDays} of the last ${expectedDays} ${expectedDays === 1 ? 'day' : 'days'}`;
    return scheduled > 0 ? `${ci} and logged ${logged} of ${scheduled} doses.` : `${ci}.`;
  },
  weekMissedCheckIns: (weekdays: string[]) =>
    weekdays.length === 1
      ? `${weekdays[0]}'s check-in was missed.`
      : `Check-ins were missed on ${listNames(weekdays)}.`,
  weekNoData: (name: string) => `There's no history for ${name} yet. Check back after a day or two of check-ins.`,

  // ---- set_sharing ----
  sharingPaused: () => "Sharing is paused; your family will know it's paused, but not why. Say 'resume sharing' any time.",
  sharingResumed: () => 'Sharing is back on. Your family can see your check-ins and medicine log again.',
  sharingAlreadyPaused: () => "Sharing is already paused. Say 'resume sharing' any time.",
  sharingAlreadyOn: () => "Sharing is already on. Say 'pause sharing' if you'd like a break.",
};

/** Scope label for spoken dose replies. */
export function scopeLabel(part: 'morning' | 'afternoon' | 'evening' | 'all'): string {
  if (part === 'morning') return 'this morning';
  if (part === 'afternoon') return 'this afternoon';
  if (part === 'evening') return 'this evening';
  return 'today';
}

export function roleLabel(role: Role): string {
  if (role === 'recipient') return 'the person Care Circle looks after';
  if (role === 'admin') return 'lead caregiver';
  return 'family member';
}

// ---- emails ----
export interface EmailContent {
  subject: string;
  text: string;
}

export const emailCopy = {
  missedCheckIn: (name: string, windowEnd: string): EmailContent => ({
    subject: `${name} hasn't checked in today`,
    text: `${name}'s check-in window ended at ${windowEnd}. You may want to give ${name} a call.`,
  }),
  missedDose: (name: string, time: string, medName: string): EmailContent => ({
    subject: `${name}'s ${time} ${medName} isn't logged yet`,
    text: `The ${time} ${medName} hasn't been logged in Care Circle. You may want to check in with ${name}.`,
  }),
  crisis: (name: string, at: string, category: CrisisCategory): EmailContent =>
    category === 'injury'
      ? {
          subject: `${name} mentioned a fall or injury at ${at}`,
          text: `Care Circle suggested ${name} call 911 if help is needed now. ${name}'s words are on your dashboard.`,
        }
      : {
          subject: `${name} said something that may need your attention at ${at}`,
          text: `Care Circle suggested ${name} call or text 988, or call 911 if in danger. ${name}'s words are on your dashboard.`,
        },
  message: (name: string, messageText: string): EmailContent => ({
    subject: `A message from ${name}`,
    text: messageText,
  }),
  allClear: (name: string, at: string, windowEnd: string): EmailContent => ({
    subject: `${name} checked in at ${at}`,
    text: `${name} checked in after the window ended at ${windowEnd}.`,
  }),
  sharingChanged: (name: string, paused: boolean): EmailContent =>
    paused
      ? {
          subject: `${name} paused sharing`,
          text: `While sharing is paused, Care Circle won't share ${name}'s check-ins or medicine log, or send missed check-in alerts.`,
        }
      : {
          subject: `${name} resumed sharing`,
          text: `${name}'s check-ins and medicine log are shared with the family again.`,
        },
};

/** Every copy function with sample arguments, for the copy-lint test. */
export function allSpeechSamples(): string[] {
  const n = 'Margaret';
  const cg = ['Sarah', 'Tom'];
  return [
    copy.unavailable(),
    copy.notMember(),
    copy.recipientOnly(n),
    copy.caregiverOnly(),
    copy.badInput(),
    copy.tooLong(),
    copy.helpAnonymous(),
    copy.helpNoCircle(),
    copy.helpRecipient(),
    copy.helpCaregiver(n),
    copy.joinCodeNotFound(),
    copy.joinLocked(),
    copy.joinAlreadyMember(),
    copy.joinRecipientTaken(),
    copy.joinReadBackRecipient(n, cg),
    copy.joinReadBackRecipient(n, []),
    copy.joinReadBackMember(n),
    copy.joinedRecipient(),
    copy.joinedMember(n),
    copy.checkInShared(n, '8:40', cg),
    copy.checkInShared(n, '8:40', []),
    copy.checkInPaused(n, '8:40'),
    copy.crisisRedirect('injury'),
    copy.crisisRedirect('self_harm'),
    copy.crisisCheckIn('injury', n, cg, false),
    copy.crisisCheckIn('injury', n, cg, true),
    copy.crisisCheckIn('injury', n, [], false),
    copy.crisisCheckIn('self_harm', n, cg, false),
    copy.crisisCheckIn('self_harm', n, cg, true),
    copy.dosesNone('this morning'),
    copy.dosesAllLogged(1, 'today'),
    copy.dosesAllLogged(2, 'this morning'),
    copy.dosesList(['metformin at 8', 'lisinopril at 9'], 2, 0),
    copy.dosesList(['lisinopril at 9'], 1, 1),
    copy.doseNotFound(),
    copy.doseWhich(['the 8 metformin', 'the 8 pm metformin']),
    copy.doseNeedName(),
    copy.doseAlreadyLogged('metformin', 'this morning'),
    copy.doseNothingOpen('this morning'),
    copy.doseBulkReadBack(['metformin', 'lisinopril'], 'this morning', 'taken'),
    copy.doseLogged(['metformin'], 'taken', '8:42', ['lisinopril']),
    copy.doseLogged(['metformin'], 'taken', '8:42', []),
    copy.doseLogged(['metformin'], 'skipped', '8:42', ['lisinopril', 'aspirin']),
    copy.messageSending(cg),
    copy.messageNoOne(),
    copy.messageCrisis('injury', cg),
    copy.messageCrisis('self_harm', []),
    copy.statusPaused(n),
    copy.statusNotYet(n, '10:00 am'),
    copy.statusMissed(n, '10:00 am'),
    `${copy.statusCheckedIn(n, '8:40', 'okay', true)} ${copy.statusDoses(1, 2, ['lisinopril'])}`,
    `${copy.statusSelfCheckedIn('8:40')} ${copy.statusDoses(2, 2, [])}`,
    copy.statusSelfNotYet('10:00 am'),
    copy.statusDoses(0, 5, ['a', 'b', 'c']),
    copy.statusDoses(0, 2, ['metformin', 'lisinopril']),
    copy.statusDoses(2, 5, ['a', 'b', 'c']),
    `${copy.weekSummary(n, 6, 7, 25, 28)} ${copy.weekMissedCheckIns(['Tuesday'])}`,
    copy.weekMissedCheckIns(['Tuesday', 'Friday']),
    copy.weekNoData(n),
    copy.sharingPaused(),
    copy.sharingResumed(),
    copy.sharingAlreadyPaused(),
    copy.sharingAlreadyOn(),
  ];
}

export function allEmailSamples(): EmailContent[] {
  const n = 'Margaret';
  return [
    emailCopy.missedCheckIn(n, '10:00 am'),
    emailCopy.missedDose(n, '9:00 am', 'lisinopril'),
    emailCopy.crisis(n, '9:12 am', 'injury'),
    emailCopy.crisis(n, '9:12 am', 'self_harm'),
    emailCopy.message(n, 'Could someone bring milk?'),
    emailCopy.allClear(n, '11:05 am', '10:00 am'),
    emailCopy.sharingChanged(n, true),
    emailCopy.sharingChanged(n, false),
  ];
}
