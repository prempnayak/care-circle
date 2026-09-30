import { copy, TransactionFailedError } from '@care-circle/core';
import { requireMember, requireRecipient, succeed, ToolError, type Outcome, type ToolContext } from './common';
import type { ToolInput } from './definitions';

/**
 * Pause or resume sharing (GSI1 + circle read + one transaction; one SQS send).
 * While paused, check-ins are still recorded, caregivers hear "paused", and no missed alerts go out.
 */
export async function setSharing(ctx: ToolContext, input: ToolInput<'set_sharing'>): Promise<Outcome<'set_sharing'>> {
  const member = await requireMember(ctx);
  requireRecipient(member);
  const { store, clock, queue } = ctx.services;
  const now = clock.now();

  const circle = await store.getCircle(member.circleId);
  if (!circle) throw new ToolError(copy.notMember());
  if (circle.meta.paused === input.paused) {
    return succeed({ speech: input.paused ? copy.sharingAlreadyPaused() : copy.sharingAlreadyOn(), paused: input.paused });
  }

  try {
    await store.updateCircle({ ...circle.meta, paused: input.paused }, [
      store.auditPut(member.circleId, member.sub, input.paused ? 'pause_sharing' : 'resume_sharing', 'set_sharing', true, now),
    ]);
  } catch (err) {
    if (err instanceof TransactionFailedError) throw new ToolError(copy.unavailable());
    throw err;
  }
  await queue.send({
    type: 'sharing_changed',
    circleId: member.circleId,
    itemKey: `SHARING#${now.toISOString()}`,
    at: now.toISOString(),
    data: { paused: input.paused },
  });
  return succeed({ speech: input.paused ? copy.sharingPaused() : copy.sharingResumed(), paused: input.paused });
}
