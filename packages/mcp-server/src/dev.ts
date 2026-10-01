/**
 * Demo controls (dev only): move the clock, run the sweep, reset and seed.
 * Mounted only when DEV_ENDPOINTS=true, and every call needs the X-Dev-Key header.
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { addDays, localInstant, MemoryQueue, resetTable, seedDemo, seedFresh, todayIn, type Services } from '@care-circle/core';
import { runScheduledPass } from '@care-circle/workers';

const clockBody = z.union([
  z.object({ now: z.string().datetime({ offset: true }) }),
  z.object({ offsetMinutes: z.number() }),
  z.object({ reset: z.literal(true) }),
  // "Tomorrow at 10:35 in New York": a local wall-clock time some days from the clock's current date.
  z.object({ dayOffset: z.number().int().min(-30).max(30), at: z.string().regex(/^\d{2}:\d{2}$/), tz: z.string() }),
]);

function keyMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDevRoutes(services: Services) {
  const app = new Hono();
  const { config, adjustableClock, store } = services;

  app.use('*', async (c, next) => {
    if (!config.DEV_ENDPOINTS || !config.DEV_KEY || !keyMatches(config.DEV_KEY, c.req.header('x-dev-key'))) {
      return c.json({ error: 'not_found' }, 404);
    }
    await next();
  });

  app.get('/clock', (c) => c.json({ now: services.clock.now().toISOString() }));

  app.post('/clock', async (c) => {
    if (!adjustableClock) return c.json({ error: 'clock_not_adjustable' }, 400);
    const body = clockBody.parse(await c.req.json());
    if ('now' in body) adjustableClock.set(new Date(body.now));
    else if ('offsetMinutes' in body) adjustableClock.advance(body.offsetMinutes * 60_000);
    else if ('dayOffset' in body) {
      const date = addDays(todayIn(services.clock, body.tz), body.dayOffset);
      adjustableClock.set(localInstant(date, body.at, body.tz).toJSDate());
    }
    else adjustableClock.reset();
    return c.json({ now: services.clock.now().toISOString() });
  });

  /** Run the materializer and sweep now, then wait for any alert emails to go out. */
  app.post('/sweep', async (c) => {
    const result = await runScheduledPass(services);
    if (services.queue instanceof MemoryQueue) await services.queue.drain();
    return c.json(result);
  });

  app.post('/reset', async (c) => {
    adjustableClock?.reset();
    await resetTable(store.db);
    const which = c.req.query('seed') ?? 'demo';
    if (which === 'fresh') await seedFresh(store);
    else if (which === 'demo') await seedDemo(store, services.clock, services.crypto);
    return c.json({ ok: true, seeded: which });
  });

  app.post('/seed', async (c) => {
    const which = c.req.query('seed') ?? 'demo';
    if (which === 'fresh') await seedFresh(store);
    else await seedDemo(store, services.clock, services.crypto);
    return c.json({ ok: true, seeded: which });
  });

  return app;
}
