import { z } from 'zod';

export const ROLES = ['recipient', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const MOODS = ['good', 'okay', 'not_great'] as const;
export type Mood = (typeof MOODS)[number];

export const CHECKIN_STATUSES = ['open', 'done', 'missed'] as const;
export type CheckInStatus = (typeof CHECKIN_STATUSES)[number];

export const DOSE_STATUSES = ['open', 'taken', 'skipped', 'missed'] as const;
export type DoseStatus = (typeof DOSE_STATUSES)[number];

export const ALERT_TYPES = ['missed_checkin', 'missed_dose', 'crisis', 'message', 'all_clear', 'sharing_changed'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Bounded free text: the only two free-text fields in the product. */
export const NOTE_MAX = 140;
export const MESSAGE_MAX = 140;

export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Use 24-hour HH:mm');

export const windowSchema = z.object({ start: hhmmSchema, end: hhmmSchema }).refine((w) => w.start < w.end, {
  message: 'The window must end after it starts',
});
export type CheckInWindow = z.infer<typeof windowSchema>;

export const alertOptInSchema = z.object({
  missedCheckIn: z.boolean(),
  missedDose: z.boolean(),
  crisis: z.boolean(),
  message: z.boolean(),
});
export type AlertOptIn = z.infer<typeof alertOptInSchema>;

export function defaultAlertOptIn(role: Role): AlertOptIn {
  if (role === 'admin') return { missedCheckIn: true, missedDose: true, crisis: true, message: true };
  if (role === 'member') return { missedCheckIn: true, missedDose: false, crisis: true, message: true };
  return { missedCheckIn: false, missedDose: false, crisis: false, message: false };
}

export interface MemberSummary {
  sub: string;
  firstName: string;
  role: Role;
}

export interface CircleMeta {
  circleId: string;
  recipientSub?: string;
  recipientFirstName: string;
  tz: string;
  window: CheckInWindow;
  graceMin: number;
  doseGraceMin: number;
  paused: boolean;
  createdBy: string;
  createdAt: string;
  /** Denormalized member list (source of truth is the MEMBER# items). */
  members: MemberSummary[];
}

/** The subset of the circle copied onto every member item, so one GSI1 query answers "who am I and where". */
export interface CircleSnapshot {
  circleId: string;
  recipientFirstName: string;
  tz: string;
  window: CheckInWindow;
  graceMin: number;
  paused: boolean;
  members: MemberSummary[];
}

export interface Member {
  circleId: string;
  sub: string;
  role: Role;
  firstName: string;
  alertOptIn: AlertOptIn;
  consentAt: string;
  circle: CircleSnapshot;
}

export interface UserProfile {
  sub: string;
  firstName?: string;
  email?: string;
  attempts?: { count: number; windowStart: string };
}

export interface Medication {
  medId: string;
  displayName: string;
  aliases: string[];
  times: string[];
  active: boolean;
}

export interface CheckIn {
  date: string;
  status: CheckInStatus;
  deadline: string;
  at?: string;
  lastAt?: string;
  mood?: Mood;
  noteCipher?: string;
  crisis?: boolean;
  alertSent?: boolean;
}

export interface Dose {
  date: string;
  doseId: string;
  medId: string;
  name: string;
  aliases: string[];
  time: string;
  status: DoseStatus;
  deadline: string;
  loggedAt?: string;
  loggedBy?: string;
  late?: boolean;
  alertSent?: boolean;
}

export interface StoredMessage {
  circleId: string;
  sk: string;
  at: string;
  fromSub: string;
  textCipher: string;
  crisis: boolean;
}

export interface JoinCode {
  code: string;
  circleId: string;
  role: Exclude<Role, 'admin'>;
  createdBy: string;
  createdAt: string;
}

export interface AlertRecord {
  type: AlertType;
  itemKey: string;
  recipients: string[];
  channel: 'email';
  status: 'sending' | 'sent' | 'failed' | 'skipped';
  sentAt?: string;
}

/** A message on the alert queue. Never carries note or message text; the notifier reads it from the table. */
export const alertMessageSchema = z.object({
  type: z.enum(ALERT_TYPES),
  circleId: z.string(),
  /** Deterministic key of the thing the alert is about; makes the alert idempotent. */
  itemKey: z.string(),
  /** When the triggering event happened (UTC ISO). */
  at: z.string(),
  data: z
    .object({
      category: z.enum(['injury', 'self_harm']).optional(),
      source: z.enum(['check_in', 'message']).optional(),
      medName: z.string().optional(),
      time: z.string().optional(),
      paused: z.boolean().optional(),
      windowEnd: z.string().optional(),
    })
    .default({}),
});
export type AlertMessage = z.infer<typeof alertMessageSchema>;
