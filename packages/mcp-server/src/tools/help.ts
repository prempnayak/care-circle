import { copy, MEDICAL_DISCLAIMER } from '@care-circle/core';
import { succeed, type Outcome, type ToolContext } from './common';

/** Works without a token; tailors the reply to the caller's role when they're linked and in a circle. */
export async function careCircleHelp(ctx: ToolContext): Promise<Outcome<'care_circle_help'>> {
  if (!ctx.user) return succeed({ speech: copy.helpAnonymous(), role: 'none', disclaimer: MEDICAL_DISCLAIMER });
  const { membership } = await ctx.services.store.getIdentity(ctx.user.sub);
  if (!membership) return succeed({ speech: copy.helpNoCircle(), role: 'none', disclaimer: MEDICAL_DISCLAIMER });
  const speech =
    membership.role === 'recipient' ? copy.helpRecipient() : copy.helpCaregiver(membership.circle.recipientFirstName);
  return succeed({ speech, role: membership.role, disclaimer: MEDICAL_DISCLAIMER });
}
