import { checkInSk, copy, matchCrisis, todayIn } from '@care-circle/core';
import { caregiverNames, readInbox, requireMember, requireRecipient, spokenAt, succeed, type Outcome, type ToolContext } from './common';
import type { ToolInput } from './definitions';

/**
 * Record today's check-in (DynamoDB: GSI1 query + one update + audit put; SQS only for crisis or all-clear).
 * Crisis wording in the note gets the redirect spoken first, then the family is emailed. Otherwise any
 * waiting family messages are read aloud and cleared in the same write as the audit record.
 */
export async function checkIn(ctx: ToolContext, input: ToolInput<'check_in'>): Promise<Outcome<'check_in'>> {
  const member = await requireMember(ctx);
  requireRecipient(member);
  const { store, clock, crypto, queue } = ctx.services;
  const circle = member.circle;
  const now = clock.now();
  const date = todayIn(clock, circle.tz);

  const crisis = matchCrisis(input.note).category;
  const noteCipher = input.note ? await crypto.encrypt(input.note, member.circleId) : undefined;
  const { previous, at } = await store.recordCheckIn({
    circleId: member.circleId,
    date,
    now,
    mood: input.mood,
    noteCipher,
    crisis: crisis !== null,
  });

  const caregivers = caregiverNames(circle);
  if (crisis && !circle.paused && caregivers.length > 0) {
    await queue.send({
      type: 'crisis',
      circleId: member.circleId,
      itemKey: `${checkInSk(date)}#${now.toISOString()}`,
      at: now.toISOString(),
      data: { category: crisis, source: 'check_in' },
    });
  }
  // A late check-in after a missed-check-in email gets a short all-clear.
  if (previous?.alertSent && previous.status === 'missed' && !circle.paused) {
    await queue.send({ type: 'all_clear', circleId: member.circleId, itemKey: checkInSk(date), at: now.toISOString(), data: {} });
  }
  // The crisis redirect comes first and alone; family messages wait for the next turn.
  const inbox = crisis ? { notes: [], count: 0 } : await readInbox(ctx, member);
  const action = crisis ? 'check_in_crisis' : 'check_in';
  if (inbox.count > 0) {
    await store.transact([store.auditPut(member.circleId, member.sub, action, 'check_in', true, now), store.inboxShift(member.circleId, member.sub, inbox.count)]);
  } else {
    await store.writeAudit(member.circleId, member.sub, action, 'check_in', true, now);
  }

  const atSpoken = spokenAt(at, circle.tz);
  let speech: string;
  if (crisis) speech = copy.crisisCheckIn(crisis, member.firstName, caregivers, circle.paused);
  else if (inbox.notes.length > 0)
    speech = `${copy.checkInBrief(member.firstName, atSpoken, caregivers, circle.paused)} ${copy.familyNotesSpoken(inbox.notes)}`;
  else if (circle.paused) speech = copy.checkInPaused(member.firstName, atSpoken);
  else speech = copy.checkInShared(member.firstName, atSpoken, caregivers);

  return succeed({
    speech,
    date,
    at,
    ...(input.mood ? { mood: input.mood } : {}),
    crisis: crisis !== null,
    sharedWith: circle.paused ? [] : caregivers,
    ...(inbox.notes.length > 0 ? { familyMessages: inbox.notes } : {}),
  });
}
