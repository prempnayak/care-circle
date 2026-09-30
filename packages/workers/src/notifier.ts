import {
  clockWithMeridiem,
  emailCopy,
  localInstant,
  renderEmail,
  scheduleTimeWithMeridiem,
  type AlertMessage,
  type AlertOptIn,
  type EmailContent,
  type Member,
  type Services,
} from '@care-circle/core';
import { DateTime } from 'luxon';

const OPT_IN_KEY: Record<AlertMessage['type'], keyof AlertOptIn | null> = {
  missed_checkin: 'missedCheckIn',
  missed_dose: 'missedDose',
  crisis: 'crisis',
  message: 'message',
  all_clear: 'missedCheckIn',
  sharing_changed: null,
};

export type NotifyOutcome = 'sent' | 'duplicate' | 'resolved' | 'no_recipients' | 'paused' | 'gone';

function dateFromItemKey(itemKey: string): string | null {
  return /^DAY#(\d{4}-\d{2}-\d{2})#/.exec(itemKey)?.[1] ?? null;
}

/**
 * Notifier (SQS consumer): pick recipients by opt-in, claim the alert with a conditional put
 * (so each alert goes out once), send the email, and record sent/failed. Throws on send failure
 * so the queue retries (DLQ after 3 attempts).
 */
export async function handleAlert(services: Services, msg: AlertMessage): Promise<NotifyOutcome> {
  const { store, clock, mailer, config, logger } = services;
  const circle = await store.getCircle(msg.circleId);
  if (!circle) return 'gone';
  const { meta, members } = circle;
  const name = meta.recipientFirstName;

  if (meta.paused && msg.type !== 'message' && msg.type !== 'sharing_changed') return 'paused';

  // A dose or check-in logged late cancels its missed alert.
  if (msg.type === 'missed_checkin' || msg.type === 'missed_dose') {
    if (!(await store.markAlertSent(msg.circleId, msg.itemKey))) return 'resolved';
  }

  const optKey = OPT_IN_KEY[msg.type];
  const recipients: Member[] = members.filter((m) => m.role !== 'recipient' && (optKey === null || m.alertOptIn[optKey]));
  if (recipients.length === 0) return 'no_recipients';

  const now = clock.now();
  const subs = recipients.map((m) => m.sub);
  if (!(await store.claimAlert(msg.circleId, msg.type, msg.itemKey, subs, now))) return 'duplicate';

  try {
    const profiles = await store.getProfiles(subs);
    const to = subs.map((s) => profiles.get(s)?.email).filter((e): e is string => Boolean(e));
    if (to.length === 0) {
      await store.finishAlert(msg.circleId, msg.type, msg.itemKey, 'skipped', now);
      return 'no_recipients';
    }
    const content = await buildContent(services, msg, name, meta.tz, meta.window.end);
    await mailer.send(renderEmail(to, content, config.DASHBOARD_URL));
    await store.finishAlert(msg.circleId, msg.type, msg.itemKey, 'sent', clock.now());
    logger.info('alert sent', { type: msg.type, circleId: msg.circleId, recipients: to.length });
    return 'sent';
  } catch (err) {
    await store.finishAlert(msg.circleId, msg.type, msg.itemKey, 'failed', clock.now());
    logger.warn('alert failed', { type: msg.type, circleId: msg.circleId, err });
    throw err;
  }

  async function buildContent(
    s: Services,
    m: AlertMessage,
    recipientName: string,
    tz: string,
    windowEndHHmm: string,
  ): Promise<EmailContent> {
    const at = clockWithMeridiem(DateTime.fromISO(m.at, { zone: 'utc' }).setZone(tz));
    const date = dateFromItemKey(m.itemKey) ?? DateTime.fromISO(m.at, { zone: 'utc' }).setZone(tz).toISODate()!;
    const windowEnd = clockWithMeridiem(localInstant(date, windowEndHHmm, tz));
    switch (m.type) {
      case 'missed_checkin':
        return emailCopy.missedCheckIn(recipientName, windowEnd);
      case 'missed_dose':
        return emailCopy.missedDose(recipientName, scheduleTimeWithMeridiem(m.data.time ?? '00:00'), m.data.medName ?? 'medicine');
      case 'crisis':
        return emailCopy.crisis(recipientName, at, m.data.category ?? 'injury');
      case 'message': {
        const stored = await s.store.getMessage(m.circleId, m.itemKey);
        const text = stored ? await s.crypto.decrypt(stored.textCipher, m.circleId) : '';
        return emailCopy.message(recipientName, text);
      }
      case 'all_clear':
        return emailCopy.allClear(recipientName, at, windowEnd);
      case 'sharing_changed':
        return emailCopy.sharingChanged(recipientName, Boolean(m.data.paused));
    }
  }
}

