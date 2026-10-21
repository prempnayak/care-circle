import { addDays, copy, localInstant, todayIn, weekdayName, type Dose } from '@care-circle/core';
import {
  buildCard,
  requireCaregiver,
  requireMember,
  spokenAt,
  succeed,
  windowEndSpoken,
  type Outcome,
  type ToolContext,
} from './common';
import type { ToolInput, ToolOutput } from './definitions';

const isLogged = (d: Dose) => d.status === 'taken' || d.status === 'skipped';

/**
 * How the person Care Circle looks after is doing today (one day query). Never includes note text:
 * a caregiver only hears that a note exists and that it's on the dashboard.
 */
export async function getStatus(ctx: ToolContext, _input: ToolInput<'get_status'>): Promise<Outcome<'get_status'>> {
  const member = await requireMember(ctx);
  const { store, clock } = ctx.services;
  const circle = member.circle;
  const now = clock.now();
  const date = todayIn(clock, circle.tz);
  const windowEnd = windowEndSpoken(circle, date);
  const self = member.role === 'recipient';

  if (circle.paused && !self) {
    await store.writeAudit(member.circleId, member.sub, 'get_status', 'get_status', true, now);
    return succeed({
      speech: copy.statusPaused(circle.recipientFirstName),
      date,
      checkIn: null,
      windowEnd,
      doses: { logged: 0, open: 0, missed: 0 },
      hasNote: false,
      paused: true,
    });
  }

  const day = await store.getDay(member.circleId, date);
  await store.writeAudit(member.circleId, member.sub, 'get_status', 'get_status', true, now);

  const ci = day.checkIn?.status === 'done' ? day.checkIn : undefined;
  const logged = day.doses.filter(isLogged);
  const missed = day.doses.filter((d) => d.status === 'missed');
  const open = day.doses.filter((d) => d.status === 'open');
  const notLoggedNames = [...missed, ...open].map((d) => d.name);
  const dosesSentence = copy.statusDoses(logged.length, day.doses.length, notLoggedNames);
  const hasNote = Boolean(ci?.noteCipher);

  let first: string;
  if (ci?.at) {
    const at = spokenAt(ci.at, circle.tz);
    first = self ? copy.statusSelfCheckedIn(at) : copy.statusCheckedIn(circle.recipientFirstName, at, ci.mood, hasNote);
  } else {
    const deadlinePassed =
      day.checkIn?.status === 'missed' ||
      localInstant(date, circle.window.end, circle.tz).plus({ minutes: circle.graceMin }).toJSDate() < now;
    if (self) first = copy.statusSelfNotYet(windowEnd);
    else first = deadlinePassed ? copy.statusMissed(circle.recipientFirstName, windowEnd) : copy.statusNotYet(circle.recipientFirstName, windowEnd);
  }

  return succeed({
    speech: dosesSentence ? `${first} ${dosesSentence}` : first,
    date,
    checkIn: ci?.at ? { at: ci.at, ...(ci.mood ? { mood: ci.mood } : {}) } : null,
    windowEnd,
    doses: { logged: logged.length, open: open.length, missed: missed.length },
    hasNote,
    paused: circle.paused,
    today: buildCard(circle, date, day.checkIn, day.doses, now, { canLog: self }),
  });
}

/** Check-in days and logged doses over the last N days (one range query), for family members. */
export async function getWeekSummary(ctx: ToolContext, input: ToolInput<'get_week_summary'>): Promise<Outcome<'get_week_summary'>> {
  const member = await requireMember(ctx);
  requireCaregiver(member);
  const { store, clock } = ctx.services;
  const circle = member.circle;
  const now = clock.now();
  const days = input.days;
  const today = todayIn(clock, circle.tz);
  const start = addDays(today, -(days - 1));
  const name = circle.recipientFirstName;

  const empty: ToolOutput<'get_week_summary'> = {
    speech: '',
    days,
    checkInDays: 0,
    expectedDays: 0,
    dosesLogged: 0,
    dosesScheduled: 0,
    misses: [],
    paused: circle.paused,
  };
  if (circle.paused) {
    await store.writeAudit(member.circleId, member.sub, 'get_week_summary', 'get_week_summary', true, now);
    return succeed({ ...empty, speech: copy.statusPaused(name) });
  }

  const range = await store.getDayRange(member.circleId, start, today);
  await store.writeAudit(member.circleId, member.sub, 'get_week_summary', 'get_week_summary', true, now);

  // Only count resolved items: today's still-open check-in or doses aren't misses yet.
  const resolvedCheckIns = range.checkIns.filter((c) => c.status !== 'open');
  const checkInDays = resolvedCheckIns.filter((c) => c.status === 'done').length;
  const resolvedDoses = range.doses.filter((d) => d.status !== 'open');
  const dosesLogged = resolvedDoses.filter(isLogged).length;
  const missedCheckIns = resolvedCheckIns.filter((c) => c.status === 'missed').sort((a, b) => a.date.localeCompare(b.date));
  const missedDoses = resolvedDoses.filter((d) => d.status === 'missed');
  const misses = [
    ...missedCheckIns.map((c) => ({ date: c.date, kind: 'check_in' as const })),
    ...missedDoses.map((d) => ({ date: d.date, kind: 'dose' as const, name: d.name })),
  ].slice(0, 5);

  if (resolvedCheckIns.length === 0 && resolvedDoses.length === 0) {
    return succeed({ ...empty, speech: copy.weekNoData(name) });
  }

  let speech = copy.weekSummary(name, checkInDays, resolvedCheckIns.length, dosesLogged, resolvedDoses.length);
  if (missedCheckIns.length > 0) {
    speech += ` ${copy.weekMissedCheckIns(missedCheckIns.slice(-5).map((c) => weekdayName(c.date)))}`;
  }
  return succeed({
    speech,
    days,
    checkInDays,
    expectedDays: resolvedCheckIns.length,
    dosesLogged,
    dosesScheduled: resolvedDoses.length,
    misses,
    paused: false,
  });
}
