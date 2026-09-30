/**
 * Demo data (handoff §14): Margaret's circle with Sarah (admin) and Tom (member), two medicines,
 * and 14 days of history with realistic gaps. `fresh` leaves only Sarah, for recording setup (J1).
 */
import type { Clock } from './clock';
import type { Crypto } from './crypto';
import { alertSk, checkInSk, circlePk, doseIdFor, doseSk, messageSk, ttl } from './db/keys';
import { snapshotOf, type CareStore } from './db/store';
import { checkInDeadline, doseDeadline, materializeCircle } from './materialize';
import { addDays, localInstant, todayIn, toUtcIso } from './time';
import { defaultAlertOptIn, type CircleMeta, type Medication, type Member, type Mood } from './types';

export const DEMO_CIRCLE_ID = 'cdemomargaret';
export const DEMO_TZ = 'America/New_York';
export const DEMO_PEOPLE = {
  margaret: { sub: 'dev-margaret', firstName: 'Margaret', email: 'margaret@example.com' },
  sarah: { sub: 'dev-sarah', firstName: 'Sarah', email: 'sarah@example.com' },
  tom: { sub: 'dev-tom', firstName: 'Tom', email: 'tom@example.com' },
} as const;

export const DEMO_MEDS: Medication[] = [
  { medId: 'mmetfor', displayName: 'metformin', aliases: ['diabetes pill', 'diabetes medicine'], times: ['08:00'], active: true },
  { medId: 'mlisino', displayName: 'lisinopril', aliases: ['blood pressure pill', 'blood pressure medicine'], times: ['09:00'], active: true },
];

/** Deterministic pseudo-random numbers so every seed looks the same. */
function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Only Sarah's profile: she creates the circle on the dashboard while recording J1. */
export async function seedFresh(store: CareStore): Promise<void> {
  await store.upsertProfile(DEMO_PEOPLE.sarah.sub, { firstName: 'Sarah', email: DEMO_PEOPLE.sarah.email });
}

export async function seedDemo(store: CareStore, clock: Clock, crypto: Crypto): Promise<{ circleId: string }> {
  const now = clock.now();
  const { margaret, sarah, tom } = DEMO_PEOPLE;
  const meta: CircleMeta = {
    circleId: DEMO_CIRCLE_ID,
    recipientSub: margaret.sub,
    recipientFirstName: margaret.firstName,
    tz: DEMO_TZ,
    window: { start: '07:00', end: '10:00' },
    graceMin: 30,
    doseGraceMin: 60,
    paused: false,
    createdBy: sarah.sub,
    createdAt: toUtcIso(localInstant(addDays(todayIn(clock, DEMO_TZ), -15), '19:00', DEMO_TZ)),
    members: [
      { sub: sarah.sub, firstName: sarah.firstName, role: 'admin' },
      { sub: margaret.sub, firstName: margaret.firstName, role: 'recipient' },
      { sub: tom.sub, firstName: tom.firstName, role: 'member' },
    ],
  };
  const snap = snapshotOf(meta);
  const member = (p: { sub: string; firstName: string }, role: Member['role']): Record<string, unknown> => ({
    PK: circlePk(meta.circleId),
    SK: `MEMBER#${p.sub}`,
    GSI1PK: `USER#${p.sub}`,
    GSI1SK: circlePk(meta.circleId),
    type: 'member',
    circleId: meta.circleId,
    sub: p.sub,
    role,
    firstName: p.firstName,
    alertOptIn: defaultAlertOptIn(role),
    consentAt: meta.createdAt,
    circle: snap,
  });
  const profile = (p: { sub: string; firstName: string; email: string }) => ({
    PK: `USER#${p.sub}`,
    SK: 'PROFILE',
    GSI1PK: `USER#${p.sub}`,
    GSI1SK: 'PROFILE',
    type: 'user',
    sub: p.sub,
    firstName: p.firstName,
    email: p.email,
  });

  const items: Record<string, unknown>[] = [
    { PK: circlePk(meta.circleId), SK: 'META', type: 'circle', ...meta, version: 0 },
    member(sarah, 'admin'),
    member(margaret, 'recipient'),
    member(tom, 'member'),
    profile(sarah),
    profile(margaret),
    profile(tom),
    ...DEMO_MEDS.map((m) => ({ PK: circlePk(meta.circleId), SK: `MED#${m.medId}`, type: 'med', ...m })),
  ];

  // History: 14 days before today. Missed check-ins on days 5 and 12 back; a few unlogged doses.
  const rand = prng(20261001);
  const today = todayIn(clock, DEMO_TZ);
  const moods: Mood[] = ['good', 'good', 'okay', 'good', 'okay', 'not_great'];
  const missedCheckIns = new Set([5, 12]);
  const missedDoses = new Set(['3:mlisino', '5:mmetfor', '5:mlisino', '9:mlisino', '12:mmetfor', '12:mlisino']);
  for (let back = 14; back >= 1; back--) {
    const date = addDays(today, -back);
    const exp = ttl.thirteenMonths(now);
    const deadline = checkInDeadline(meta, date);
    if (missedCheckIns.has(back)) {
      items.push({ PK: circlePk(meta.circleId), SK: checkInSk(date), type: 'checkin', date, status: 'missed', deadline, alertSent: true, expiresAt: exp });
      items.push({
        PK: circlePk(meta.circleId),
        SK: alertSk('missed_checkin', checkInSk(date)),
        type: 'alert',
        alertType: 'missed_checkin',
        itemKey: checkInSk(date),
        recipients: [sarah.sub, tom.sub],
        channel: 'email',
        status: 'sent',
        claimedAt: deadline,
        sentAt: deadline,
        expiresAt: exp,
      });
    } else {
      const minute = 10 + Math.floor(rand() * 80); // 07:10–08:30
      const at = toUtcIso(localInstant(date, `0${7 + Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`, DEMO_TZ));
      const note = back === 2 ? 'The garden looks lovely this morning.' : back === 8 ? 'Slept badly, but fine now.' : undefined;
      items.push({
        PK: circlePk(meta.circleId),
        SK: checkInSk(date),
        type: 'checkin',
        date,
        status: 'done',
        deadline,
        at,
        lastAt: at,
        mood: moods[Math.floor(rand() * moods.length)],
        ...(note ? { noteCipher: await crypto.encrypt(note, meta.circleId) } : {}),
        expiresAt: exp,
      });
    }
    for (const med of DEMO_MEDS) {
      for (const time of med.times) {
        const missed = missedDoses.has(`${back}:${med.medId}`);
        const loggedAt = toUtcIso(localInstant(date, time, DEMO_TZ).plus({ minutes: Math.floor(rand() * 40) }));
        items.push({
          PK: circlePk(meta.circleId),
          SK: doseSk(date, time, med.medId),
          type: 'dose',
          date,
          doseId: doseIdFor(date, time, med.medId),
          medId: med.medId,
          name: med.displayName,
          aliases: med.aliases,
          time,
          status: missed ? 'missed' : 'taken',
          deadline: doseDeadline(meta, date, time),
          ...(missed ? { alertSent: true } : { loggedAt, loggedBy: margaret.firstName, late: false }),
          expiresAt: exp,
        });
      }
    }
  }

  // One message from last week.
  const msgAt = toUtcIso(localInstant(addDays(today, -4), '15:20', DEMO_TZ));
  const msgSk = messageSk(msgAt, 'demo');
  items.push({
    PK: circlePk(meta.circleId),
    SK: msgSk,
    type: 'message',
    sk: msgSk,
    circleId: meta.circleId,
    at: msgAt,
    fromSub: margaret.sub,
    textCipher: await crypto.encrypt('Could someone pick up milk on Saturday?', meta.circleId),
    crisis: false,
    expiresAt: ttl.ninetyDays(now),
  });

  await store.batchPut(items);
  // Today's and tomorrow's open items, as the materializer would have made them yesterday.
  await materializeCircle(store, clock, meta, { medications: DEMO_MEDS, includeOverdue: true });
  return { circleId: meta.circleId };
}
