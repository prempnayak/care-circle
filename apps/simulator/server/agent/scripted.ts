import { FALLBACK_REPLY, route } from './router';
import type { Agent, AgentContext, AgentReply } from './types';

type Part = 'morning' | 'afternoon' | 'evening';

function partOf(hhmm: string): Part {
  const h = Number(hhmm.slice(0, 2));
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

/**
 * Scripted agent: regex routing plus a tiny bit of dialogue state, so "yes" after a read-back
 * calls the same tool again with confirm: true (commitments need an explicit yes).
 */
export class ScriptedAgent implements Agent {
  readonly name = 'scripted' as const;

  async routeOnly(utterance: string) {
    const r = route(utterance);
    return r.kind === 'tool' ? { name: r.name, args: r.args } : { name: null, args: {} };
  }

  async respond(ctx: AgentContext, utterance: string): Promise<AgentReply> {
    const r = route(utterance);
    const pending = ctx.persona.pending;
    ctx.persona.pending = undefined;
    ctx.trace.push({ at: new Date().toISOString(), kind: 'agent', label: `scripted route: ${r.kind === 'tool' ? r.name : r.kind}` });

    if (r.kind === 'no') return { reply: pending ? "Okay, I won't." : 'Okay.', toolCalls: [] };
    if (r.kind === 'say') return { reply: r.text, toolCalls: [] };
    if (r.kind === 'yes' && !pending) return { reply: FALLBACK_REPLY, toolCalls: [] };

    const call = r.kind === 'yes' ? pending! : { name: r.name, args: r.args };
    const conn = await ctx.connect();
    try {
      const result = await conn.call(call.name, call.args);
      const sc = result.structuredContent as Record<string, unknown> | undefined;
      // Remember what a "yes" should do next.
      if (!result.isError && sc) {
        if (call.name === 'join_circle' && sc.step === 'confirm') {
          ctx.persona.pending = { name: 'join_circle', args: { ...call.args, confirm: true } };
        } else if (call.name === 'log_dose' && sc.step === 'confirm') {
          ctx.persona.pending = { name: 'log_dose', args: { ...call.args, confirm: true } };
        } else if (call.name === 'get_todays_doses') {
          const open = ((sc.doses as { time: string; status: string }[]) ?? []).filter((d) => d.status === 'open' || d.status === 'missed');
          if (open.length > 0) {
            const requested = call.args.part_of_day as string | undefined;
            const part = requested && requested !== 'all' ? (requested as Part) : partOf(open[0]!.time);
            // The list was just read back, so a "yes" logs that part of the day.
            ctx.persona.pending = { name: 'log_dose', args: { part_of_day: part, status: 'taken', confirm: true } };
          }
        }
      }
      return { reply: result.speech, toolCalls: [result] };
    } finally {
      await conn.close();
    }
  }
}
