import { DateTime } from 'luxon';
import {
  clockShort,
  clockWithMeridiem,
  copy,
  localInstant,
  scheduleTime,
  type CheckIn,
  type CircleSnapshot,
  type Dose,
  type Member,
  type Services,
} from '@care-circle/core';
import type { AuthUser } from '../auth/verifier';
import type { CardData, ToolName, ToolOutput } from './definitions';

export interface ToolContext {
  services: Services;
  user: AuthUser | null;
  /** Set by requireMember so the dispatcher can audit failed calls too. */
  member?: Member;
}

/** A tool either succeeds with its structured output (which includes `speech`) or fails with a speakable message. */
export type Outcome<N extends ToolName> = { ok: true; output: ToolOutput<N> } | { ok: false; speech: string };

export const fail = (speech: string) => ({ ok: false as const, speech });
export const succeed = <T>(output: T) => ({ ok: true as const, output });

/** Thrown inside a tool to stop with a speakable message. */
export class ToolError extends Error {
  constructor(readonly speech: string) {
    super(speech);
  }
}

/** The caller's membership, from one GSI1 query. Not being a member is a normal tool error, not a 401. */
export async function requireMember(ctx: ToolContext): Promise<Member> {
  if (!ctx.user) throw new ToolError(copy.notMember());
  const identity = await ctx.services.store.getIdentity(ctx.user.sub);
  if (!identity.membership) throw new ToolError(copy.notMember());
  ctx.member = identity.membership;
  return identity.membership;
}

export function requireRecipient(member: Member): void {
  if (member.role !== 'recipient') throw new ToolError(copy.recipientOnly(member.circle.recipientFirstName));
}

export function requireCaregiver(member: Member): void {
  if (member.role === 'recipient') throw new ToolError(copy.caregiverOnly());
}

/** How many family messages can wait for the person Care Circle looks after. */
export const INBOX_MAX = 2;

/** Waiting family messages for the cared-for person, decrypted for reading aloud (comes with the GSI1 identity read). */
export async function readInbox(ctx: ToolContext, member: Member): Promise<{ notes: { from: string; text: string }[]; count: number }> {
  const waiting = (member.inbox ?? []).slice(0, INBOX_MAX);
  const notes: { from: string; text: string }[] = [];
  for (const n of waiting) {
    const text = await ctx.services.crypto.decrypt(n.textCipher, member.circleId).catch(() => null);
    if (text) notes.push({ from: n.fromName, text });
  }
  // `count` includes any note that failed to decrypt, so it's still cleared.
  return { notes, count: waiting.length };
}

/** First names of everyone in the circle except the person Care Circle looks after. */
export function caregiverNames(circle: CircleSnapshot): string[] {
  return circle.members.filter((m) => m.role !== 'recipient').map((m) => m.firstName);
}

export function localTime(iso: string, tz: string): DateTime {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz);
}

export function spokenAt(iso: string, tz: string): string {
  return clockShort(localTime(iso, tz));
}

export function windowEndSpoken(circle: CircleSnapshot, date: string): string {
  return clockWithMeridiem(localInstant(date, circle.window.end, circle.tz));
}

export function dateLabel(date: string): string {
  return DateTime.fromISO(date, { zone: 'utc' }).toFormat('cccc, LLLL d');
}

/** "metformin at 8" */
export function doseLabel(dose: Pick<Dose, 'name' | 'time'>): string {
  return `${dose.name} at ${scheduleTime(dose.time)}`;
}

/** Card data: rendered by the MCP App card from the same structuredContent the speech came from. */
export function buildCard(
  circle: CircleSnapshot,
  date: string,
  checkIn: CheckIn | undefined,
  doses: Dose[],
  now: Date,
  opts: { canLog?: boolean } = {},
): CardData {
  const canLog = Boolean(opts.canLog) && !circle.paused;
  let status: CardData['checkIn']['status'] = 'open';
  if (checkIn?.status === 'done') status = 'done';
  else if (checkIn?.status === 'missed') status = 'missed';
  else if (!checkIn && localInstant(date, circle.window.end, circle.tz).plus({ minutes: circle.graceMin }).toJSDate() < now) {
    status = 'missed';
  }
  return {
    recipientName: circle.recipientFirstName,
    date,
    dateLabel: dateLabel(date),
    paused: circle.paused,
    checkIn: {
      status,
      ...(checkIn?.at ? { at: spokenAt(checkIn.at, circle.tz) } : {}),
      ...(checkIn?.mood ? { mood: checkIn.mood } : {}),
    },
    doses: doses.map((d) => ({ name: d.name, time: scheduleTime(d.time), status: d.status, ...(canLog ? { doseId: d.doseId } : {}) })),
    ...(canLog ? { canLog: true } : {}),
  };
}

/** Record the call in the audit trail without payload contents. Never fails the tool. */
export async function audit(ctx: ToolContext, member: Member, tool: ToolName, ok: boolean): Promise<void> {
  try {
    await ctx.services.store.writeAudit(member.circleId, member.sub, tool, tool, ok, ctx.services.clock.now());
  } catch (err) {
    ctx.services.logger.warn('audit write failed', { tool, err });
  }
}
