import { copy, defaultAlertOptIn, TransactionFailedError } from '@care-circle/core';
import { caregiverNames, fail, succeed, ToolError, type Outcome, type ToolContext } from './common';
import type { ToolInput } from './definitions';

const MAX_FAILURES_PER_HOUR = 5;

/**
 * Join a circle with a 6-digit code. Without `confirm` this only reads back what will be shared;
 * with `confirm` (after a spoken "yes") it records consent and joins.
 */
export async function joinCircle(ctx: ToolContext, input: ToolInput<'join_circle'>): Promise<Outcome<'join_circle'>> {
  const user = ctx.user;
  if (!user) throw new ToolError(copy.notMember());
  const { store, clock } = ctx.services;
  const now = clock.now();

  // The identity query and the code lookup are independent, so run them together.
  const [identity, code] = await Promise.all([store.getIdentity(user.sub), store.getJoinCode(input.code, now)]);
  if (identity.membership) return fail(copy.joinAlreadyMember());

  const attempts = identity.profile?.attempts;
  const lockedOut =
    attempts && attempts.count >= MAX_FAILURES_PER_HOUR && now.getTime() - new Date(attempts.windowStart).getTime() < 60 * 60 * 1000;
  if (lockedOut) return fail(copy.joinLocked());

  const circle = code ? await store.getCircle(code.circleId) : null;
  if (!code || !circle) {
    const count = await store.recordFailedJoin(user.sub, now, attempts);
    return fail(count >= MAX_FAILURES_PER_HOUR ? copy.joinLocked() : copy.joinCodeNotFound());
  }

  const { meta } = circle;
  if (code.role === 'recipient' && meta.recipientSub) return fail(copy.joinRecipientTaken());

  const caregivers = meta.members.filter((m) => m.role !== 'recipient').map((m) => m.firstName);
  if (!input.confirm) {
    const speech =
      code.role === 'recipient'
        ? copy.joinReadBackRecipient(meta.recipientFirstName, caregivers)
        : copy.joinReadBackMember(meta.recipientFirstName);
    return succeed({ speech, step: 'confirm', circleId: meta.circleId, role: code.role, members: caregivers });
  }

  const firstName = code.role === 'recipient' ? meta.recipientFirstName : (user.givenName ?? identity.profile?.firstName ?? 'Family member');
  try {
    const next = await store.joinCircle({
      code: code.code,
      meta,
      member: {
        circleId: meta.circleId,
        sub: user.sub,
        role: code.role,
        firstName,
        alertOptIn: defaultAlertOptIn(code.role),
        consentAt: now.toISOString(),
      },
      email: user.email,
      now,
    });
    const speech = code.role === 'recipient' ? copy.joinedRecipient() : copy.joinedMember(meta.recipientFirstName);
    return succeed({
      speech,
      step: 'joined',
      circleId: meta.circleId,
      role: code.role,
      members: caregiverNames({ ...meta, members: next.members }),
    });
  } catch (err) {
    // Someone else used the code or changed the circle at the same moment.
    if (err instanceof TransactionFailedError) return fail(copy.joinCodeNotFound());
    throw err;
  }
}
