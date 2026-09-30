import { accessToken, API_URL } from './auth';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, 'Please sign in again.');
  const res = await fetch(`${API_URL}/api${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? 'Something went wrong');
  return data as T;
}

export type Role = 'recipient' | 'admin' | 'member';
export interface Me {
  sub: string;
  firstName: string | null;
  email: string | null;
  membership: { circleId: string; role: Role } | null;
}
export interface Circle {
  circleId: string;
  recipientFirstName: string;
  tz: string;
  window: { start: string; end: string };
  graceMin: number;
  doseGraceMin: number;
  paused: boolean;
  hasRecipient: boolean;
  createdBy: string;
  members: { sub: string; firstName: string; role: Role }[];
}
export interface Medication {
  medId: string;
  displayName: string;
  aliases: string[];
  times: string[];
  active: boolean;
}
export interface AlertOptIn {
  missedCheckIn: boolean;
  missedDose: boolean;
  crisis: boolean;
  message: boolean;
}
export interface MemberRow {
  sub: string;
  firstName: string;
  role: Role;
  consentAt: string;
  alertOptIn?: AlertOptIn;
}
export interface Timeline {
  tz: string;
  paused: boolean;
  days: {
    date: string;
    checkIn: { status: string; at: string | null; mood: string | null; note: string | null; crisis: boolean } | null;
    doses: { name: string; time: string; status: string; loggedAt: string | null; late: boolean }[];
  }[];
  messages: { at: string; text: string | null; crisis: boolean }[];
  alerts: { type: string; status: string; sentAt: string | null }[];
}
