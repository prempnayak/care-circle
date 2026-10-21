import { copy, matchCrisis, TransactionFailedError, type Member } from '@care-circle/core';
import { caregiverNames, fail, INBOX_MAX, requireMember, succeed, type Outcome, type ToolContext } from './common';
import type { ToolInput } from './definitions';

/**
 * From the person Care Circle looks after: store an encrypted message and email it to the family.
 * From a family member: store it and queue it to be read aloud to the person Care Circle looks after
 * the next time they talk to Care Circle. Either way, the text is never spoken to a caregiver.
 */
export async function messageCircle(ctx: ToolContext, input: ToolInput<'message_circle'>): Promise<Outcome<'message_circle'>> {
  const member = await requireMember(ctx);
  if (member.role !== 'recipient') return messageFromFamily(ctx, member, input.message);
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

/** A family member's note to the person Care Circle looks after (DynamoDB: GSI1 query + one transaction). */
async function messageFromFamily(ctx: ToolContext, member: Member, message: string): Promise<Outcome<'message_circle'>> {
  const { store, clock, crypto } = ctx.services;
  const circle = member.circle;
  const recipientName = circle.recipientFirstName;
  // Crisis wording is redirected first and never relayed: the person Care Circle looks after can't act on it.
  const crisis = matchCrisis(message).category;
  if (crisis) return fail(copy.familyNoteCrisis(crisis));
  const recipient = circle.members.find((m) => m.role === 'recipient');
  if (!recipient) return fail(copy.familyNoteNoRecipient(recipientName));

  const now = clock.now();
  const textCipher = await crypto.encrypt(message, member.circleId);
  const { item } = store.messagePut(
    { circleId: member.circleId, at: now.toISOString(), fromSub: member.sub, textCipher, crisis: false, toRecipient: true, fromName: member.firstName },
    now,
  );
  try {
    await store.transact([
      item,
      store.inboxAppend(member.circleId, recipient.sub, { fromSub: member.sub, fromName: member.firstName, textCipher, at: now.toISOString() }, INBOX_MAX),
      store.auditPut(member.circleId, member.sub, 'message_recipient', 'message_circle', true, now),
    ]);
  } catch (err) {
    if (err instanceof TransactionFailedError && err.reasons[1] === 'ConditionalCheckFailed') return fail(copy.familyNoteFull(recipientName));
    throw err;
  }
  return succeed({ speech: copy.familyNoteQueued(recipientName), sentTo: [recipientName], crisis: false });
}
