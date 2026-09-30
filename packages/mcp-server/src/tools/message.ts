import { copy, matchCrisis } from '@care-circle/core';
import { caregiverNames, fail, requireMember, requireRecipient, succeed, type Outcome, type ToolContext } from './common';
import type { ToolInput } from './definitions';

/** Store an encrypted message and email it to the family. The text is never spoken to a caregiver. */
export async function messageCircle(ctx: ToolContext, input: ToolInput<'message_circle'>): Promise<Outcome<'message_circle'>> {
  const member = await requireMember(ctx);
  requireRecipient(member);
  const { store, clock, crypto, queue } = ctx.services;
  const caregivers = caregiverNames(member.circle);
  const crisis = matchCrisis(input.message).category;
  if (caregivers.length === 0) {
    return fail(crisis ? copy.messageCrisis(crisis, []) : copy.messageNoOne());
  }

  const now = clock.now();
  const textCipher = await crypto.encrypt(input.message, member.circleId);
  const { item, sk } = store.messagePut(
    { circleId: member.circleId, at: now.toISOString(), fromSub: member.sub, textCipher, crisis: crisis !== null },
    now,
  );
  await store.transact([item, store.auditPut(member.circleId, member.sub, 'message_circle', 'message_circle', true, now)]);

  // A message is an explicit request to reach the family, so it goes out even while sharing is paused.
  await queue.send({ type: 'message', circleId: member.circleId, itemKey: sk, at: now.toISOString(), data: {} });
  if (crisis) {
    await queue.send({
      type: 'crisis',
      circleId: member.circleId,
      itemKey: sk,
      at: now.toISOString(),
      data: { category: crisis, source: 'message' },
    });
  }

  return succeed({
    speech: crisis ? copy.messageCrisis(crisis, caregivers) : copy.messageSending(caregivers),
    sentTo: caregivers,
    crisis: crisis !== null,
  });
}
