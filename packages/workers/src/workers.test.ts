import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_CIRCLE_ID, DEMO_PEOPLE, checkInSk, materializeAll, seedDemo } from '@care-circle/core';
import { testServices, type TestServices } from '../../../tests/support/services';
import { handleAlert } from './notifier';
import { runScheduledPass } from './runner';
import { runSweep } from './sweep';

let s: TestServices;

beforeEach(async () => {
  s = await testServices('2026-10-06T12:35:00Z'); // 8:35 am New York
  await seedDemo(s.store, s.clock, s.crypto);
  s.queue.subscribe((m) => handleAlert(s, m).then(() => undefined));
});
afterEach(async () => {
  await s.queue.drain();
  await s.cleanup();
});

const subjects = () => s.mailer.outbox.map((e) => e.subject);

describe('materializer', () => {
  it('is idempotent and creates today and tomorrow', async () => {
    const first = await materializeAll(s.store, s.clock);
    expect(first.checkInsCreated + first.dosesCreated).toBe(0); // the seed already materialized
    const tomorrow = await s.store.getDay(DEMO_CIRCLE_ID, '2026-10-07');
    expect(tomorrow.checkIn?.status).toBe('open');
    expect(tomorrow.doses).toHaveLength(2);
  });
});

describe('sweep (J5)', () => {
  it('flags a missed check-in after window end + grace and emails the family once', async () => {
    s.adjustableClock.set(new Date('2026-10-06T14:29:00Z')); // 10:29, still within grace
    await runSweep(s);
    await s.queue.drain();
    expect(subjects()).not.toContain("Margaret hasn't checked in today");

    s.adjustableClock.set(new Date('2026-10-06T14:35:00Z')); // 10:35
    // Two overlapping sweeps: only the winner of the conditional update alerts.
    const [a, b] = await Promise.all([runSweep(s), runSweep(s)]);
    expect(a.missed + b.missed).toBeGreaterThanOrEqual(1);
    await s.queue.drain();
    const missed = s.mailer.outbox.filter((e) => e.subject === "Margaret hasn't checked in today");
    expect(missed).toHaveLength(1);
    expect(missed[0]!.to.sort()).toEqual([DEMO_PEOPLE.sarah.email, DEMO_PEOPLE.tom.email].sort());
    expect(missed[0]!.text).toContain("Margaret's check-in window ended at 10:00 am.");
    expect(missed[0]!.text).toContain('Care Circle is not an emergency service. In an emergency, call 911.');
  });

  it('sends a missed-dose email to the admin only (default opt-ins)', async () => {
    s.adjustableClock.set(new Date('2026-10-06T14:05:00Z')); // 10:05: metformin (8:00) is past 60 min grace
    await runSweep(s);
    await s.queue.drain();
    const dose = s.mailer.outbox.find((e) => e.subject === "Margaret's 8:00 am metformin isn't logged yet");
    expect(dose?.to).toEqual([DEMO_PEOPLE.sarah.email]);
  });

  it('records misses but sends nothing while sharing is paused', async () => {
    const { meta } = (await s.store.getCircle(DEMO_CIRCLE_ID))!;
    await s.store.updateCircle({ ...meta, paused: true });
    s.adjustableClock.set(new Date('2026-10-06T14:35:00Z'));
    const r = await runSweep(s);
    await s.queue.drain();
    expect(r.missed).toBeGreaterThan(0);
    expect(r.alertsQueued).toBe(0);
    expect(s.mailer.outbox).toHaveLength(0);
    expect((await s.store.getCheckIn(DEMO_CIRCLE_ID, '2026-10-06'))?.status).toBe('missed');
  });

  it('runs through the scheduled pass and a day jump (demo controls path)', async () => {
    s.adjustableClock.set(new Date('2026-10-07T14:35:00Z')); // tomorrow 10:35
    await runScheduledPass(s);
    await s.queue.drain();
    expect(subjects()).toContain("Margaret hasn't checked in today");
    // The day after tomorrow now exists too.
    expect((await s.store.getDay(DEMO_CIRCLE_ID, '2026-10-08')).checkIn?.status).toBe('open');
  });
});

describe('notifier', () => {
  it('sends each alert once even if the message is delivered twice', async () => {
    const msg = { type: 'crisis' as const, circleId: DEMO_CIRCLE_ID, itemKey: 'X#1', at: '2026-10-06T13:12:00Z', data: { category: 'injury' as const } };
    expect(await handleAlert(s, msg)).toBe('sent');
    expect(await handleAlert(s, msg)).toBe('duplicate');
    expect(s.mailer.outbox).toHaveLength(1);
    expect(s.mailer.outbox[0]!.subject).toBe('Margaret mentioned a fall or injury at 9:12 am');
  });

  it('retries after a failed send and then sends', async () => {
    s.mailer.failNext = 1;
    const msg = { type: 'sharing_changed' as const, circleId: DEMO_CIRCLE_ID, itemKey: 'SHARING#1', at: '2026-10-06T13:00:00Z', data: { paused: true } };
    await expect(handleAlert(s, msg)).rejects.toThrow();
    expect(await handleAlert(s, msg)).toBe('sent');
    expect(subjects()).toEqual(['Margaret paused sharing']);
  });

  it('skips a missed-check-in alert if the check-in arrived before the email went out', async () => {
    s.adjustableClock.set(new Date('2026-10-06T14:35:00Z'));
    await s.store.markMissed(`CIRCLE#${DEMO_CIRCLE_ID}`, checkInSk('2026-10-06'));
    await s.store.recordCheckIn({ circleId: DEMO_CIRCLE_ID, date: '2026-10-06', now: s.clock.now(), crisis: false });
    const r = await handleAlert(s, { type: 'missed_checkin', circleId: DEMO_CIRCLE_ID, itemKey: checkInSk('2026-10-06'), at: s.clock.now().toISOString(), data: {} });
    expect(r).toBe('resolved');
    expect(s.mailer.outbox).toHaveLength(0);
  });

  it('never quotes a crisis note in the subject and includes message text only in message emails', async () => {
    await handleAlert(s, { type: 'crisis', circleId: DEMO_CIRCLE_ID, itemKey: 'C#1', at: '2026-10-06T13:12:00Z', data: { category: 'self_harm' } });
    expect(s.mailer.outbox[0]!.subject).not.toMatch(/die|harm|life/i);
    expect(s.mailer.outbox[0]!.text).toContain('988');
  });
});
