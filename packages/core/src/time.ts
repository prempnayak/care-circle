import { DateTime } from 'luxon';
import type { Clock } from './clock';

export type PartOfDay = 'morning' | 'afternoon' | 'evening';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isHHmm(value: string): boolean {
  return HHMM.test(value);
}

export function nowIn(clock: Clock, tz: string): DateTime {
  return DateTime.fromJSDate(clock.now(), { zone: tz });
}

/** Today's date (yyyy-MM-dd) in the circle's time zone. */
export function todayIn(clock: Clock, tz: string): string {
  return nowIn(clock, tz).toISODate()!;
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days }).toISODate()!;
}

/**
 * The instant a local wall-clock time happens on a date in a zone.
 * In the spring-forward gap (e.g. 02:30 on Mar 8, 2026 in New York) luxon moves forward
 * to the next valid time; on the fall-back overlap it picks the earlier instant.
 */
export function localInstant(date: string, hhmm: string, tz: string): DateTime {
  const [h, m] = hhmm.split(':').map(Number);
  return DateTime.fromISO(date, { zone: tz }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

export function toUtcIso(dt: DateTime): string {
  return dt.toUTC().toISO({ suppressMilliseconds: false })!;
}

export function partOfDay(hhmm: string): PartOfDay {
  const hour = Number(hhmm.slice(0, 2));
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export function isValidTimeZone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/** Weekday name for a yyyy-MM-dd date, e.g. "Tuesday". */
export function weekdayName(date: string): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).toFormat('cccc');
}

function meridiem(hour: number): string {
  return hour < 12 ? 'am' : 'pm';
}

function hour12(hour: number): number {
  const h = hour % 12;
  return h === 0 ? 12 : h;
}

/** "10:00 am", "9:05 pm" */
export function clockWithMeridiem(dt: DateTime): string {
  return `${hour12(dt.hour)}:${String(dt.minute).padStart(2, '0')} ${meridiem(dt.hour)}`;
}

/** Spoken time of an event: "8:40" in the morning, "2:15 pm" later. */
export function clockShort(dt: DateTime): string {
  const base = `${hour12(dt.hour)}:${String(dt.minute).padStart(2, '0')}`;
  return dt.hour < 12 ? base : `${base} pm`;
}

/** Spoken schedule time from "HH:mm": "8", "8:30", "9 pm". */
export function scheduleTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const base = m === 0 ? `${hour12(h)}` : `${hour12(h)}:${String(m).padStart(2, '0')}`;
  return h < 12 ? base : `${base} pm`;
}

/** Schedule time with meridiem, for emails: "9:00 am". */
export function scheduleTimeWithMeridiem(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${hour12(h)}:${String(m).padStart(2, '0')} ${meridiem(h)}`;
}
