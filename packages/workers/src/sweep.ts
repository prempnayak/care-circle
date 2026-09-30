import { addDays, type CircleMeta, type Services } from '@care-circle/core';

export interface SweepResult {
  checked: number;
  missed: number;
  alertsQueued: number;
}

const PK_PREFIX = 'CIRCLE#';

/**
 * Sweep evaluator (every 5 min in the cloud, every minute locally).
 * Open items past their deadline flip open → missed with a conditional update; only the winner
 * of that condition queues an alert, so overlapping sweeps can't double-alert.
 */
export async function runSweep(services: Services): Promise<SweepResult> {
  const { store, clock, queue, logger } = services;
  const now = clock.now();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  // Deadlines are bucketed by UTC date; look back two days in case a sweep was skipped.
  const buckets = [addDays(today, -2), addDays(today, -1), today];
  const items = (await Promise.all(buckets.map((d) => store.dueItems(d, nowIso)))).flat();
  const circles = new Map<string, CircleMeta | null>();
  const result: SweepResult = { checked: items.length, missed: 0, alertsQueued: 0 };

  for (const item of items) {
    const pk = String(item.PK);
    const sk = String(item.SK);
    if (!(await store.markMissed(pk, sk))) continue;
    result.missed++;
    const circleId = pk.slice(PK_PREFIX.length);
    if (!circles.has(circleId)) circles.set(circleId, (await store.getCircle(circleId))?.meta ?? null);
    const meta = circles.get(circleId);
    if (!meta || meta.paused) continue; // paused: recorded as missed, no alert

    if (item.type === 'checkin') {
      await queue.send({ type: 'missed_checkin', circleId, itemKey: sk, at: String(item.deadline), data: {} });
    } else if (item.type === 'dose') {
      await queue.send({
        type: 'missed_dose',
        circleId,
        itemKey: sk,
        at: String(item.deadline),
        data: { medName: String(item.name), time: String(item.time) },
      });
    } else {
      continue;
    }
    result.alertsQueued++;
  }
  if (result.missed > 0) logger.info('sweep', { ...result });
  return result;
}
