import { checkInSk, copy, matchCrisis, todayIn } from '@care-circle/core';
import { caregiverNames, requireMember, requireRecipient, spokenAt, succeed, type Outcome, type ToolContext } from './common';
import type { ToolInput } from './definitions';

/**
 * Record today's check-in (DynamoDB: GSI1 query + one update + audit put; SQS only for crisis or all-clear).
 * Crisis wording in the note gets the redirect spoken first, then the family is emailed.
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
  await store.writeAudit(member.circleId, member.sub, crisis ? 'check_in_crisis' : 'check_in', 'check_in', true, now);

  const atSpoken = spokenAt(at, circle.tz);
  let speech: string;
  if (crisis) speech = copy.crisisCheckIn(crisis, member.firstName, caregivers, circle.paused);
  else if (circle.paused) speech = copy.checkInPaused(member.firstName, atSpoken);
  else speech = copy.checkInShared(member.firstName, atSpoken, caregivers);

  return succeed({
    speech,
    date,
    at,
    ...(input.mood ? { mood: input.mood } : {}),
    crisis: crisis !== null,
    sharedWith: circle.paused ? [] : caregivers,
  });
}
