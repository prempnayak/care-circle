import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_CIRCLE_ID, DEMO_PEOPLE, circlePk, seedDemo } from '@care-circle/core';
import { testServices, type TestServices } from '../../../../tests/support/services';
import type { AuthUser } from '../auth/verifier';
import { runTool, type ToolName } from './index';

const as = (sub: string, givenName?: string, email?: string): AuthUser => ({
  sub,
  givenName,
  email,
  clientId: 'test',
  scopes: ['carecircle/circle'],
  token: 't',
  audience: [],
});
const margaret = as(DEMO_PEOPLE.margaret.sub, 'Margaret');
const sarah = as(DEMO_PEOPLE.sarah.sub, 'Sarah');
const tom = as(DEMO_PEOPLE.tom.sub, 'Tom');

let s: TestServices;

async function call(user: AuthUser | null, name: ToolName, args: Record<string, unknown> = {}) {
  const outcome = await runTool(name, { services: s, user }, args);
  if (outcome.ok) return { ok: true as const, speech: outcome.output.speech, out: outcome.output as Record<string, unknown> };
  return { ok: false as const, speech: outcome.speech, out: {} as Record<string, unknown> };
}

async function partition(prefix: string) {
  const res = await s.store.db.doc.send(
    new QueryCommand({
      TableName: s.store.db.table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': circlePk(DEMO_CIRCLE_ID), ':p': prefix },
    }),
  );
  return res.Items ?? [];
}

beforeEach(async () => {
  // Tue Oct 6, 2026, 8:35 am in New York.
  s = await testServices('2026-10-06T12:35:00Z');
  await seedDemo(s.store, s.clock, s.crypto);
});
afterEach(async () => {
  await s.queue.drain();
  await s.cleanup();
});

describe('care_circle_help', () => {
  it('works without a token and mentions 911', async () => {
    const r = await call(null, 'care_circle_help');
    expect(r.ok).toBe(true);
    expect(r.speech).toContain('call 911');
    expect(r.out.disclaimer).toContain('not a substitute for professional medical advice');
  });

  it('tailors to role', async () => {
    expect((await call(margaret, 'care_circle_help')).speech).toContain("'I'm up'");
    expect((await call(sarah, 'care_circle_help')).speech).toContain('how Margaret is doing');
    expect((await call(as('someone-new'), 'care_circle_help')).speech).toContain('join code');
  });
});

describe('check_in (J2)', () => {
  it('records the check-in and names who it is shared with', async () => {
    const r = await call(margaret, 'check_in', { mood: 'okay', note: 'A bit tired today' });
    expect(r.speech).toBe('Thanks, Margaret. Your check-in at 8:35 is shared with Sarah and Tom.');
    expect(r.out.crisis).toBe(false);
    expect(s.queue.sent).toHaveLength(0);
  });

  it('keeps the first time on a second check-in and encrypts the note', async () => {
    await call(margaret, 'check_in', { note: 'Garden is lovely' });
    s.adjustableClock.advance(20 * 60_000);
    const r = await call(margaret, 'check_in', { mood: 'good' });
    expect(r.speech).toContain('8:35');
    const day = await s.store.getDay(DEMO_CIRCLE_ID, '2026-10-06');
    expect(day.checkIn?.status).toBe('done');
    expect(day.checkIn?.noteCipher).toBeDefined();
    expect(day.checkIn?.noteCipher).not.toContain('Garden');
    expect(day.checkIn?.mood).toBe('good');
  });

  it('is only for the person Care Circle looks after', async () => {
    const r = await call(sarah, 'check_in', {});
    expect(r.ok).toBe(false);
    expect(r.speech).toContain('person Care Circle looks after');
  });

  it('says to ask for a code when the caller is not in a circle', async () => {
    const r = await call(as('stranger'), 'check_in', {});
    expect(r.ok).toBe(false);
    expect(r.speech).toBe("You're not in a Care Circle yet. Ask your family for a join code.");
  });

  it('answers an over-long note with a speakable message', async () => {
    const r = await call(margaret, 'check_in', { note: 'x'.repeat(141) });
    expect(r.ok).toBe(false);
    expect(r.speech).toContain('a bit long');
  });

  it('sends an all-clear when checking in after a missed-check-in email', async () => {
    s.adjustableClock.set(new Date('2026-10-06T14:35:00Z')); // 10:35 am
    const { runSweep, handleAlert } = await import('@care-circle/workers');
    s.queue.subscribe((m) => handleAlert(s, m).then(() => undefined));
    await runSweep(s);
    await s.queue.drain();
    expect(s.mailer.outbox.map((e) => e.subject)).toContain("Margaret hasn't checked in today");
    s.adjustableClock.set(new Date('2026-10-06T15:05:00Z'));
    await call(margaret, 'check_in', {});
    await s.queue.drain();
    expect(s.mailer.outbox.map((e) => e.subject)).toContain('Margaret checked in at 11:05 am');
  });
});

describe('crisis redirect (J6)', () => {
  it('speaks the 911 redirect first and queues a crisis alert', async () => {
    const r = await call(margaret, 'check_in', { note: 'I fell this morning' });
    expect(r.speech.startsWith("I'm sorry, Margaret; if you're hurt or need help now, call 911.")).toBe(true);
    expect(r.out.crisis).toBe(true);
    expect(s.queue.sent.map((m) => m.type)).toEqual(['crisis']);
    const audits = await partition('AUDIT#');
    expect(audits.some((a) => a.action === 'check_in_crisis')).toBe(true);
  });

  it('uses 988 for self-harm wording', async () => {
    const r = await call(margaret, 'message_circle', { message: 'I want to end my life' });
    expect(r.speech).toContain('call or text 988');
    expect(s.queue.sent.map((m) => m.type).sort()).toEqual(['crisis', 'message']);
  });

  it('while paused, still redirects but says the family was not told', async () => {
    await call(margaret, 'set_sharing', { paused: true });
    s.queue.sent.length = 0;
    const r = await call(margaret, 'check_in', { note: "I can't breathe" });
    expect(r.speech).toContain('call 911');
    expect(r.speech).toContain("hasn't been told");
    expect(s.queue.sent).toHaveLength(0);
  });
});

describe('doses (J3)', () => {
  it('lists open doses and offers to log them', async () => {
    const r = await call(margaret, 'get_todays_doses', { part_of_day: 'morning' });
    expect(r.speech).toBe('Two: metformin at 8 and lisinopril at 9. Want to log them?');
    expect((r.out.today as { doses: unknown[] }).doses).toHaveLength(2);
  });

  it('logs by name and says what is still open', async () => {
    const r = await call(margaret, 'log_dose', { medication_name: 'metformin', status: 'taken' });
    expect(r.speech).toBe('Logged metformin as taken at 8:35. Lisinopril is still open.');
    const again = await call(margaret, 'log_dose', { medication_name: 'metformin', status: 'taken' });
    expect(again.ok).toBe(false);
    expect(again.speech).toBe('Metformin is already logged for this morning.');
  });

  it('matches aliases', async () => {
    const r = await call(margaret, 'log_dose', { medication_name: 'my blood pressure pill', status: 'skipped' });
    expect(r.speech).toContain('Logged lisinopril as skipped');
  });

  it('logs by dose_id', async () => {
    const list = await call(margaret, 'get_todays_doses', {});
    const doseId = (list.out.doses as { doseId: string; name: string }[]).find((d) => d.name === 'lisinopril')!.doseId;
    const r = await call(margaret, 'log_dose', { dose_id: doseId, status: 'taken' });
    expect(r.speech).toContain('Logged lisinopril');
  });

  it('reads back several doses and logs them only after confirm', async () => {
    const first = await call(margaret, 'log_dose', { part_of_day: 'morning', status: 'taken' });
    expect(first.out.step).toBe('confirm');
    expect(first.speech).toBe("That's metformin and lisinopril for this morning. Say yes to log them as taken.");
    expect((await s.store.getDoses(DEMO_CIRCLE_ID, '2026-10-06')).every((d) => d.status === 'open')).toBe(true);
    const second = await call(margaret, 'log_dose', { part_of_day: 'morning', status: 'taken', confirm: true });
    expect(second.speech).toBe("Logged metformin and lisinopril as taken at 8:35. That's everything open for today.");
  });

  it('asks which one when a name matches several open doses, and writes nothing', async () => {
    s.adjustableClock.set(new Date('2026-10-06T11:30:00Z')); // 7:30 am, before the new 8:00 dose
    await s.store.putMedication(DEMO_CIRCLE_ID, { medId: 'mvitamn', displayName: 'vitamin D', aliases: [], times: ['08:00', '20:00'], active: true });
    const { materializeCircle } = await import('@care-circle/core');
    const { meta } = (await s.store.getCircle(DEMO_CIRCLE_ID))!;
    await materializeCircle(s.store, s.clock, meta, { resync: true });
    const r = await call(margaret, 'log_dose', { medication_name: 'vitamin d', status: 'taken' });
    expect(r.ok).toBe(false);
    expect(r.speech).toBe('Which one did you mean: the 8 vitamin D or the 8 pm vitamin D?');
    const r2 = await call(margaret, 'log_dose', { medication_name: 'vitamin d', part_of_day: 'morning', status: 'taken' });
    expect(r2.speech).toContain('Logged vitamin D');
  });

  it('marks a late log of a missed dose as late', async () => {
    s.adjustableClock.set(new Date('2026-10-06T14:05:00Z')); // 10:05, metformin deadline 9:00 passed
    const { runSweep } = await import('@care-circle/workers');
    await runSweep(s);
    await call(margaret, 'log_dose', { medication_name: 'metformin', status: 'taken' });
    const dose = (await s.store.getDoses(DEMO_CIRCLE_ID, '2026-10-06')).find((d) => d.name === 'metformin')!;
    expect(dose.status).toBe('taken');
    expect(dose.late).toBe(true);
  });

  it('tells an unknown medicine apart', async () => {
    const r = await call(margaret, 'log_dose', { medication_name: 'aspirin', status: 'taken' });
    expect(r.speech).toContain("couldn't find that medicine");
  });
});

describe('get_status (J4)', () => {
  it('reports check-in, mood and doses but never the note text', async () => {
    await call(margaret, 'check_in', { mood: 'okay', note: 'my private words' });
    await call(margaret, 'log_dose', { medication_name: 'metformin', status: 'taken' });
    const r = await call(sarah, 'get_status', { person: 'Mom' });
    expect(r.speech).toBe(
      'Margaret checked in at 8:35, feeling okay, and left a note on your dashboard. One of two medicines today is logged; lisinopril is still open.',
    );
    expect(JSON.stringify(r.out)).not.toContain('my private words');
    expect(r.out.hasNote).toBe(true);
  });

  it('before the window ends, says when it runs until', async () => {
    const r = await call(tom, 'get_status', {});
    expect(r.speech.startsWith("Margaret hasn't checked in yet today; the check-in window runs until 10:00 am.")).toBe(true);
  });

  it('says paused and nothing else while sharing is paused', async () => {
    await call(margaret, 'set_sharing', { paused: true });
    const r = await call(sarah, 'get_status', {});
    expect(r.speech).toContain('paused sharing');
    expect(r.out.checkIn).toBeNull();
  });
});

describe('get_week_summary', () => {
  it('counts check-in days and logged doses from the seeded history', async () => {
    const r = await call(sarah, 'get_week_summary', { days: 7 });
    expect(r.out.expectedDays).toBe(6);
    expect(r.out.checkInDays).toBe(5);
    expect(r.speech).toMatch(/^Margaret checked in 5 of the last 6 days and logged \d+ of \d+ doses\. \w+'s check-in was missed\.$/);
  });

  it('is for family members only', async () => {
    const r = await call(margaret, 'get_week_summary', {});
    expect(r.ok).toBe(false);
  });
});

describe('join_circle (J1)', () => {
  it('reads back, then joins after confirm, and consumes the code', async () => {
    const newbie = as('dev-priya', 'Priya', 'priya@example.com');
    const code = await s.store.createJoinCode(DEMO_CIRCLE_ID, 'member', DEMO_PEOPLE.sarah.sub, s.clock.now());
    const readBack = await call(newbie, 'join_circle', { code: code.code });
    expect(readBack.out.step).toBe('confirm');
    expect(readBack.speech).toContain("Say yes to join Margaret's circle.");
    expect((await s.store.getIdentity(newbie.sub)).membership).toBeUndefined();

    const joined = await call(newbie, 'join_circle', { code: code.code, confirm: true });
    expect(joined.out.step).toBe('joined');
    const identity = await s.store.getIdentity(newbie.sub);
    expect(identity.membership?.role).toBe('member');
    expect(identity.membership?.consentAt).toBeDefined();
    expect(await s.store.getJoinCode(code.code, s.clock.now())).toBeNull();
    // Everyone's snapshot now includes Priya.
    const r = await call(margaret, 'check_in', {});
    expect(r.speech).toContain('Sarah, Tom and Priya');
  });

  it('refuses a second recipient', async () => {
    const code = await s.store.createJoinCode(DEMO_CIRCLE_ID, 'recipient', DEMO_PEOPLE.sarah.sub, s.clock.now());
    const r = await call(as('dev-other'), 'join_circle', { code: code.code });
    expect(r.speech).toContain('already has someone');
  });

  it('locks after 5 wrong codes in an hour', async () => {
    const user = as('dev-guesser');
    for (let i = 0; i < 4; i++) expect((await call(user, 'join_circle', { code: '000000' })).speech).toContain("couldn't find");
    expect((await call(user, 'join_circle', { code: '000000' })).speech).toContain('Too many codes');
    const code = await s.store.createJoinCode(DEMO_CIRCLE_ID, 'member', DEMO_PEOPLE.sarah.sub, s.clock.now());
    expect((await call(user, 'join_circle', { code: code.code })).speech).toContain('Too many codes');
    s.adjustableClock.advance(61 * 60_000);
    expect((await call(user, 'join_circle', { code: code.code })).out.step).toBe('confirm');
  });

  it('rejects a malformed code with a speakable message', async () => {
    const r = await call(as('x'), 'join_circle', { code: '12ab' });
    expect(r.ok).toBe(false);
    expect(r.speech).toContain('six digits');
  });
});

describe('message_circle and set_sharing', () => {
  it('stores the message encrypted and queues an email', async () => {
    const r = await call(margaret, 'message_circle', { message: 'Please bring milk' });
    expect(r.speech).toBe("I'm sending that to Sarah and Tom.");
    const msgs = await partition('MSG#');
    const newest = msgs[msgs.length - 1]!;
    expect(String(newest.textCipher)).not.toContain('milk');
    expect(s.queue.sent.map((m) => m.type)).toEqual(['message']);
  });

  it('pauses and resumes, emailing the family each time', async () => {
    expect((await call(margaret, 'set_sharing', { paused: true })).speech).toContain('Sharing is paused');
    expect((await call(margaret, 'set_sharing', { paused: true })).speech).toContain('already paused');
    expect((await call(margaret, 'check_in', {})).speech).toContain('stays private while sharing is paused');
    expect((await call(margaret, 'set_sharing', { paused: false })).speech).toContain('back on');
    expect(s.queue.sent.filter((m) => m.type === 'sharing_changed')).toHaveLength(2);
  });
});

describe('audit', () => {
  it('writes an audit record for successful and failed calls, without payloads', async () => {
    await call(margaret, 'check_in', { note: 'secret words' });
    await call(sarah, 'check_in', {});
    const audits = await partition('AUDIT#');
    expect(audits.some((a) => a.tool === 'check_in' && a.ok === true)).toBe(true);
    expect(audits.some((a) => a.tool === 'check_in' && a.ok === false && a.actorSub === DEMO_PEOPLE.sarah.sub)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('secret words');
  });
});
