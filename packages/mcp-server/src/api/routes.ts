/**
 * Dashboard REST API (/api/*). Bearer JWT with the API resource as audience; roles enforced here;
 * bodies validated with zod. Notes and messages are decrypted only for signed-in circle members.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  addDays,
  alertOptInSchema,
  hhmmSchema,
  isValidTimeZone,
  materializeCircle,
  newCircleId,
  newMedId,
  todayIn,
  TransactionFailedError,
  windowSchema,
  type CircleMeta,
  type Member,
  type MetaWithVersion,
  type Services,
} from '@care-circle/core';
import { bearerToken, type AuthUser, type TokenVerifier } from '../auth/verifier';

type Env = { Variables: { user: AuthUser } };

const createCircleBody = z.object({
  recipientFirstName: z.string().trim().min(1).max(40),
  tz: z.string().refine(isValidTimeZone, 'Unknown time zone'),
  window: windowSchema,
  graceMin: z.number().int().min(0).max(180).default(30),
  doseGraceMin: z.number().int().min(15).max(240).default(60),
});

const patchCircleBody = z
  .object({
    recipientFirstName: z.string().trim().min(1).max(40),
    tz: z.string().refine(isValidTimeZone, 'Unknown time zone'),
    window: windowSchema,
    graceMin: z.number().int().min(0).max(180),
    doseGraceMin: z.number().int().min(15).max(240),
  })
  .partial();

// Medications hold only a display name, aliases and times: no drug info, dosage or strength.
const medicationBody = z.object({
  displayName: z.string().trim().min(1).max(40),
  aliases: z.array(z.string().trim().min(1).max(40)).max(5).default([]),
  times: z.array(hhmmSchema).min(1).max(6),
  active: z.boolean().default(true),
});

const codeBody = z.object({ role: z.enum(['recipient', 'member']) });

class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export function createApiRoutes(services: Services, verifier: TokenVerifier) {
  const { store, clock, crypto } = services;
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: 'invalid_request', issues: err.issues.map((i) => i.message) }, 400);
    services.logger.error('api error', { path: c.req.path, err });
    return c.json({ error: 'server_error' }, 500);
  });

  app.use('*', async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    const user = token ? await verifier.verify(token) : null;
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  /** The caller's membership in this circle, with the circle; 404 if they're not in it. */
  async function membership(c: Context<Env>, circleId: string) {
    const user = c.get('user');
    const circle = await store.getCircle(circleId);
    const me = circle?.members.find((m) => m.sub === user.sub);
    if (!circle || !me) throw new HttpError(404, 'not_found');
    return { circle, me };
  }

  function requireAdmin(me: Member) {
    if (me.role !== 'admin') throw new HttpError(403, 'forbidden');
  }

  async function resync(meta: CircleMeta) {
    await materializeCircle(store, clock, meta, { resync: true });
  }

  async function save(meta: MetaWithVersion) {
    try {
      await store.updateCircle(meta);
    } catch (err) {
      if (err instanceof TransactionFailedError) throw new HttpError(409, 'conflict');
      throw err;
    }
  }

  app.get('/me', async (c) => {
    const user = c.get('user');
    await store.upsertProfile(user.sub, { firstName: user.givenName, email: user.email });
    const { profile, membership: m } = await store.getIdentity(user.sub);
    return c.json({
      sub: user.sub,
      firstName: profile?.firstName ?? user.givenName ?? null,
      email: profile?.email ?? null,
      membership: m ? { circleId: m.circleId, role: m.role } : null,
    });
  });

  app.delete('/me', async (c) => {
    const user = c.get('user');
    const { membership: m } = await store.getIdentity(user.sub);
    if (m) {
      const circle = await store.getCircle(m.circleId);
      if (circle && (m.role === 'recipient' || circle.meta.createdBy === user.sub)) {
        // The person Care Circle looks after, or the circle's creator, leaving removes the circle's data.
        for (const other of circle.members) if (other.sub !== user.sub) await store.deleteProfile(other.sub).catch(() => {});
        await store.deleteCirclePartition(m.circleId);
      } else if (circle) {
        await store.removeMember(circle.meta, user.sub, user.sub, clock.now());
      }
    }
    await store.deleteProfile(user.sub);
    return c.body(null, 204);
  });

  app.post('/circles', async (c) => {
    const user = c.get('user');
    const body = createCircleBody.parse(await c.req.json());
    const { membership: existing } = await store.getIdentity(user.sub);
    if (existing) throw new HttpError(409, 'already_in_circle');
    const firstName = user.givenName ?? 'Family member';
    const now = clock.now();
    const meta: CircleMeta = {
      circleId: newCircleId(),
      recipientFirstName: body.recipientFirstName,
      tz: body.tz,
      window: body.window,
      graceMin: body.graceMin,
      doseGraceMin: body.doseGraceMin,
      paused: false,
      createdBy: user.sub,
      createdAt: now.toISOString(),
      members: [{ sub: user.sub, firstName, role: 'admin' }],
    };
    await store.upsertProfile(user.sub, { firstName: user.givenName, email: user.email });
    await store.createCircle(meta, {
      circleId: meta.circleId,
      sub: user.sub,
      role: 'admin',
      firstName,
      alertOptIn: { missedCheckIn: true, missedDose: true, crisis: true, message: true },
      consentAt: now.toISOString(),
    }, now);
    await materializeCircle(store, clock, meta);
    return c.json(publicCircle(meta), 201);
  });

  app.get('/circles/:id', async (c) => {
    const { circle } = await membership(c, c.req.param('id'));
    return c.json(publicCircle(circle.meta));
  });

  app.patch('/circles/:id', async (c) => {
    const { circle, me } = await membership(c, c.req.param('id'));
    requireAdmin(me);
    const patch = patchCircleBody.parse(await c.req.json());
    const next = { ...circle.meta, ...patch };
    await save(next);
    await resync(next);
    return c.json(publicCircle(next));
  });

  app.get('/circles/:id/medications', async (c) => {
    await membership(c, c.req.param('id'));
    return c.json(await store.listMedications(c.req.param('id')));
  });

  app.post('/circles/:id/medications', async (c) => {
    const { circle, me } = await membership(c, c.req.param('id'));
    requireAdmin(me);
    const body = medicationBody.parse(await c.req.json());
    const med = { medId: newMedId(), ...body, times: [...new Set(body.times)].sort() };
    await store.putMedication(circle.meta.circleId, med);
    await resync(circle.meta);
    return c.json(med, 201);
  });

  app.patch('/circles/:id/medications/:medId', async (c) => {
    const { circle, me } = await membership(c, c.req.param('id'));
    requireAdmin(me);
    const meds = await store.listMedications(circle.meta.circleId);
    const current = meds.find((m) => m.medId === c.req.param('medId'));
    if (!current) throw new HttpError(404, 'not_found');
    const patch = medicationBody.partial().parse(await c.req.json());
    const med = { ...current, ...patch, ...(patch.times ? { times: [...new Set(patch.times)].sort() } : {}) };
    await store.putMedication(circle.meta.circleId, med);
    await resync(circle.meta);
    return c.json(med);
  });

  app.delete('/circles/:id/medications/:medId', async (c) => {
    const { circle, me } = await membership(c, c.req.param('id'));
    requireAdmin(me);
    await store.deleteMedication(circle.meta.circleId, c.req.param('medId'));
    await resync(circle.meta);
    return c.body(null, 204);
  });

  app.post('/circles/:id/codes', async (c) => {
    const { circle, me } = await membership(c, c.req.param('id'));
    requireAdmin(me);
    const { role } = codeBody.parse(await c.req.json());
    if (role === 'recipient' && circle.meta.recipientSub) throw new HttpError(409, 'recipient_already_joined');
    const code = await store.createJoinCode(circle.meta.circleId, role, me.sub, clock.now());
    return c.json({ code: code.code, role: code.role, expiresAt: new Date(clock.now().getTime() + 24 * 3600 * 1000).toISOString() }, 201);
  });

  app.get('/circles/:id/members', async (c) => {
    const { circle, me } = await membership(c, c.req.param('id'));
    return c.json(
      circle.members.map((m) => ({
        sub: m.sub,
        firstName: m.firstName,
        role: m.role,
        consentAt: m.consentAt,
        // Alert settings are visible to the admin and to each member for themselves.
        ...(me.role === 'admin' || me.sub === m.sub ? { alertOptIn: m.alertOptIn } : {}),
      })),
    );
  });

  app.delete('/circles/:id/members/:sub', async (c) => {
    const { circle, me } = await membership(c, c.req.param('id'));
    const target = c.req.param('sub');
    if (me.role !== 'admin' && me.sub !== target) throw new HttpError(403, 'forbidden');
    if (!circle.members.some((m) => m.sub === target)) throw new HttpError(404, 'not_found');
    if (target === circle.meta.createdBy && me.sub === target) throw new HttpError(409, 'creator_must_delete_account');
    await store.removeMember(circle.meta, target, me.sub, clock.now());
    return c.body(null, 204);
  });

  app.patch('/circles/:id/members/:sub/alerts', async (c) => {
    const { circle, me } = await membership(c, c.req.param('id'));
    const target = c.req.param('sub');
    if (me.role !== 'admin' && me.sub !== target) throw new HttpError(403, 'forbidden');
    const member = circle.members.find((m) => m.sub === target);
    if (!member || member.role === 'recipient') throw new HttpError(404, 'not_found');
    const optIn = alertOptInSchema.parse(await c.req.json());
    await store.updateAlertOptIn(circle.meta.circleId, target, optIn);
    return c.json(optIn);
  });

  app.get('/circles/:id/timeline', async (c) => {
    const { circle } = await membership(c, c.req.param('id'));
    const meta = circle.meta;
    const days = z.coerce.number().int().min(1).max(30).default(14).parse(c.req.query('days') ?? undefined);
    const today = todayIn(clock, meta.tz);
    const start = addDays(today, -days);
    const sinceIso = new Date(clock.now().getTime() - (days + 1) * 24 * 3600 * 1000).toISOString();
    const data = await store.getTimeline(meta.circleId, start, today, sinceIso);
    const decrypt = async (cipher?: string) => (cipher ? await crypto.decrypt(cipher, meta.circleId).catch(() => null) : null);

    const byDate = new Map<string, { date: string; checkIn: unknown; doses: unknown[] }>();
    for (let d = today; d >= start; d = addDays(d, -1)) byDate.set(d, { date: d, checkIn: null, doses: [] });
    for (const ci of data.checkIns) {
      const day = byDate.get(ci.date);
      if (day)
        day.checkIn = { status: ci.status, at: ci.at ?? null, mood: ci.mood ?? null, note: await decrypt(ci.noteCipher), crisis: Boolean(ci.crisis) };
    }
    for (const d of data.doses) {
      byDate.get(d.date)?.doses.push({ name: d.name, time: d.time, status: d.status, loggedAt: d.loggedAt ?? null, late: Boolean(d.late) });
    }
    const messages = await Promise.all(
      data.messages.map(async (m) => ({ at: m.at, text: await decrypt(m.textCipher), crisis: m.crisis })),
    );
    return c.json({
      tz: meta.tz,
      paused: meta.paused,
      days: [...byDate.values()],
      messages: messages.sort((a, b) => b.at.localeCompare(a.at)),
      alerts: data.alerts
        .map((a) => ({ type: a.type, status: a.status, sentAt: a.sentAt ?? null }))
        .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? '')),
    });
  });

  return app;
}

function publicCircle(meta: CircleMeta) {
  return {
    circleId: meta.circleId,
    recipientFirstName: meta.recipientFirstName,
    tz: meta.tz,
    window: meta.window,
    graceMin: meta.graceMin,
    doseGraceMin: meta.doseGraceMin,
    paused: meta.paused,
    hasRecipient: Boolean(meta.recipientSub),
    members: meta.members,
  };
}
