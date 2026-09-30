import { copy, MESSAGE_MAX, NOTE_MAX } from '@care-circle/core';
import { audit, fail, ToolError, type Outcome, type ToolContext } from './common';
import { checkIn } from './checkin';
import { inputs, type ToolName } from './definitions';
import { getTodaysDoses, logDose } from './doses';
import { careCircleHelp } from './help';
import { joinCircle } from './join';
import { messageCircle } from './message';
import { setSharing } from './sharing';
import { getStatus, getWeekSummary } from './status';

export * from './definitions';
export type { Outcome, ToolContext } from './common';

type Handler = (ctx: ToolContext, input: never) => Promise<Outcome<ToolName>>;

const handlers: Record<ToolName, Handler> = {
  care_circle_help: careCircleHelp as Handler,
  join_circle: joinCircle as Handler,
  check_in: checkIn as Handler,
  get_todays_doses: getTodaysDoses as Handler,
  log_dose: logDose as Handler,
  message_circle: messageCircle as Handler,
  get_status: getStatus as Handler,
  get_week_summary: getWeekSummary as Handler,
  set_sharing: setSharing as Handler,
};

/** A speakable message for input that fails the schema; no field names or codes. */
export function invalidInputSpeech(name: ToolName, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name === 'check_in' && typeof a.note === 'string' && a.note.length > NOTE_MAX) return copy.tooLong();
  if (name === 'message_circle' && typeof a.message === 'string' && a.message.length > MESSAGE_MAX) return copy.tooLong();
  if (name === 'join_circle') return copy.joinCodeNotFound();
  return copy.badInput();
}

/**
 * Validate input, run the tool, and turn any failure into a speakable outcome.
 * Business errors never become protocol errors; unexpected failures say "try again in a minute".
 */
export async function runTool(name: ToolName, ctx: ToolContext, args: unknown): Promise<Outcome<ToolName>> {
  const started = performance.now();
  const parsed = inputs[name].safeParse(args ?? {});
  if (!parsed.success) {
    ctx.services.logger.info('tool input rejected', { tool: name });
    return fail(invalidInputSpeech(name, args));
  }
  let outcome: Outcome<ToolName>;
  try {
    outcome = await handlers[name](ctx, parsed.data as never);
  } catch (err) {
    if (err instanceof ToolError) outcome = fail(err.speech);
    else {
      ctx.services.logger.error('tool failed', { tool: name, err });
      outcome = fail(copy.unavailable());
    }
  }
  if (!outcome.ok && ctx.member) await audit(ctx, ctx.member, name, false);
  ctx.services.logger.info('tool call', {
    tool: name,
    ok: outcome.ok,
    ms: Math.round(performance.now() - started),
    role: ctx.member?.role,
  });
  return outcome;
}
