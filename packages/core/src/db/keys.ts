/** Key builders for the single CareCircle table (handoff §9). */
import { randomInt } from 'node:crypto';

export const META = 'META';
export const PROFILE = 'PROFILE';

export const circlePk = (circleId: string) => `CIRCLE#${circleId}`;
export const userPk = (sub: string) => `USER#${sub}`;
export const codePk = (code: string) => `CODE#${code}`;

export const memberSk = (sub: string) => `MEMBER#${sub}`;
export const medSk = (medId: string) => `MED#${medId}`;
export const dayPrefix = (date: string) => `DAY#${date}#`;
export const checkInSk = (date: string) => `DAY#${date}#CHECKIN`;
export const dosePrefix = (date: string) => `DAY#${date}#DOSE#`;
export const doseSk = (date: string, time: string, medId: string) => `DAY#${date}#DOSE#${time}#${medId}`;
export const messageSk = (iso: string, rand: string) => `MSG#${iso}#${rand}`;
export const alertSk = (type: string, itemKey: string) => `ALERT#${type}#${itemKey}`;
export const auditSk = (iso: string, rand: string) => `AUDIT#${iso}#${rand}`;

export const dueGsi2Pk = (utcDate: string) => `DUE#${utcDate}`;
export const dueGsi2Sk = (deadlineIso: string, circleId: string, sk: string) => `${deadlineIso}#${circleId}#${sk}`;

/** Stable, speech-free dose ID: "2026-10-06_0800_m1a2b3". */
export function doseIdFor(date: string, time: string, medId: string): string {
  return `${date}_${time.replace(':', '')}_${medId}`;
}

export function parseDoseId(doseId: string): { date: string; time: string; medId: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})_([a-z0-9]+)$/.exec(doseId);
  if (!m) return null;
  return { date: m[1]!, time: `${m[2]}:${m[3]}`, medId: m[4]! };
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomId(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export const newCircleId = () => `c${randomId(10)}`;
export const newMedId = () => `m${randomId(6)}`;

export function newJoinCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

const DAY_S = 24 * 60 * 60;
/** Epoch seconds for DynamoDB TTL. */
export const ttl = {
  thirteenMonths: (now: Date) => Math.floor(now.getTime() / 1000) + 396 * DAY_S,
  ninetyDays: (now: Date) => Math.floor(now.getTime() / 1000) + 90 * DAY_S,
  oneDay: (now: Date) => Math.floor(now.getTime() / 1000) + DAY_S,
};
