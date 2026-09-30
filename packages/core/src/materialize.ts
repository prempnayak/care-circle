import type { Clock } from './clock';
import { doseIdFor, doseSk } from './db/keys';
import type { CareStore } from './db/store';
import { addDays, localInstant, todayIn, toUtcIso } from './time';
import type { CircleMeta, Dose, Medication } from './types';

export interface MaterializeResult {
  checkInsCreated: number;
  dosesCreated: number;
  dosesRemoved: number;
}

export function checkInDeadline(meta: Pick<CircleMeta, 'tz' | 'window' | 'graceMin'>, date: string): string {
  return toUtcIso(localInstant(date, meta.window.end, meta.tz).plus({ minutes: meta.graceMin }));
}

export function doseDeadline(meta: Pick<CircleMeta, 'tz' | 'doseGraceMin'>, date: string, time: string): string {
  return toUtcIso(localInstant(date, time, meta.tz).plus({ minutes: meta.doseGraceMin }));
}

/**
 * Create today's and tomorrow's check-in and dose items for one circle (idempotent).
 * With `resync`, also move open check-in deadlines and drop open future doses that no longer match
 * the medication list (dashboard edits and resuming sharing).
 */
export async function materializeCircle(
  store: CareStore,
  clock: Clock,
  meta: CircleMeta,
  opts: { resync?: boolean; medications?: Medication[] } = {},
): Promise<MaterializeResult> {
  const now = clock.now();
  const today = todayIn(clock, meta.tz);
  const dates = [today, addDays(today, 1)];
  const meds = (opts.medications ?? (await store.listMedications(meta.circleId))).filter((m) => m.active);
  const result: MaterializeResult = { checkInsCreated: 0, dosesCreated: 0, dosesRemoved: 0 };

  for (const date of dates) {
    const deadline = checkInDeadline(meta, date);
    // Never create an item that is already overdue (a brand-new circle shouldn't alert about this morning).
    if (deadline > now.toISOString()) {
      if (await store.putOpenCheckIn(meta.circleId, date, deadline, now)) result.checkInsCreated++;
      else if (opts.resync) await store.moveCheckInDeadline(meta.circleId, date, deadline);
    }

    const wanted = new Map<string, { med: Medication; time: string }>();
    for (const med of meds) for (const time of med.times) wanted.set(doseSk(date, time, med.medId), { med, time });

    if (opts.resync) {
      const existing = await store.getDoses(meta.circleId, date);
      for (const dose of existing) {
        const sk = doseSk(date, dose.time, dose.medId);
        const scheduledAt = localInstant(date, dose.time, meta.tz).toJSDate();
        if (dose.status === 'open' && scheduledAt > now && !wanted.has(sk)) {
          await store.deleteOpenDose(meta.circleId, sk);
          result.dosesRemoved++;
        }
      }
    }

    for (const [sk, { med, time }] of wanted) {
      const dose: Dose = {
        date,
        doseId: doseIdFor(date, time, med.medId),
        medId: med.medId,
        name: med.displayName,
        aliases: med.aliases,
        time,
        status: 'open',
        deadline: doseDeadline(meta, date, time),
      };
      if (dose.deadline <= now.toISOString()) continue;
      // On a resync, only add doses that are still in the future.
      if (opts.resync && localInstant(date, time, meta.tz).toJSDate() <= now) continue;
      if (await store.putOpenDose(meta.circleId, dose, sk, now)) result.dosesCreated++;
    }
  }
  return result;
}

export async function materializeAll(store: CareStore, clock: Clock): Promise<MaterializeResult> {
  const total: MaterializeResult = { checkInsCreated: 0, dosesCreated: 0, dosesRemoved: 0 };
  for (const meta of await store.scanCircles()) {
    const r = await materializeCircle(store, clock, meta);
    total.checkInsCreated += r.checkInsCreated;
    total.dosesCreated += r.dosesCreated;
    total.dosesRemoved += r.dosesRemoved;
  }
  return total;
}
