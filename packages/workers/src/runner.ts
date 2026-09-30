import { materializeAll, MemoryQueue, type Services } from '@care-circle/core';
import { handleAlert } from './notifier';
import { runSweep } from './sweep';

/** One pass of the scheduled work: create upcoming items, then flag anything overdue. */
export async function runScheduledPass(services: Services) {
  const materialized = await materializeAll(services.store, services.clock);
  const sweep = await runSweep(services);
  return { materialized, sweep };
}

/**
 * Local mode: run the materializer + sweep on an interval and consume the in-process queue,
 * all inside the API process (so the demo clock and the memory queue are shared).
 */
export function startLocalWorkers(services: Services, intervalSec: number): () => void {
  if (services.queue instanceof MemoryQueue) {
    services.queue.subscribe(async (msg) => {
      await handleAlert(services, msg);
    });
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runScheduledPass(services);
    } catch (err) {
      services.logger.error('scheduled pass failed', { err });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalSec * 1000);
  return () => clearInterval(timer);
}
