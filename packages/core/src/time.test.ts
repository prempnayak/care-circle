import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  addDays,
  clockShort,
  clockWithMeridiem,
  localInstant,
  partOfDay,
  scheduleTime,
  scheduleTimeWithMeridiem,
  todayIn,
  weekdayName,
} from './time';
import { checkInDeadline, doseDeadline } from './materialize';

const NY = 'America/New_York';
const at = (iso: string) => ({ now: () => new Date(iso) });

describe('time utilities', () => {
  it('computes today in the circle time zone, not UTC', () => {
    // 02:30 UTC on Oct 6 is still Oct 5 in New York.
    expect(todayIn(at('2026-10-06T02:30:00Z'), NY)).toBe('2026-10-05');
    expect(todayIn(at('2026-10-06T04:30:00Z'), NY)).toBe('2026-10-06');
  });

  it('adds days across month ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('classifies part of day', () => {
    expect(partOfDay('08:00')).toBe('morning');
    expect(partOfDay('11:59')).toBe('morning');
    expect(partOfDay('12:00')).toBe('afternoon');
    expect(partOfDay('16:59')).toBe('afternoon');
    expect(partOfDay('17:00')).toBe('evening');
  });

  it('formats times for speech', () => {
    const dt = DateTime.fromISO('2026-10-06T08:40:00', { zone: NY });
    expect(clockShort(dt)).toBe('8:40');
    expect(clockShort(dt.set({ hour: 14, minute: 5 }))).toBe('2:05 pm');
    expect(clockWithMeridiem(dt.set({ hour: 10, minute: 0 }))).toBe('10:00 am');
    expect(clockWithMeridiem(dt.set({ hour: 0, minute: 0 }))).toBe('12:00 am');
    expect(scheduleTime('08:00')).toBe('8');
    expect(scheduleTime('08:30')).toBe('8:30');
    expect(scheduleTime('21:00')).toBe('9 pm');
    expect(scheduleTimeWithMeridiem('09:00')).toBe('9:00 am');
    expect(weekdayName('2026-10-06')).toBe('Tuesday');
  });

  describe('US daylight saving (Mar 8 and Nov 1, 2026)', () => {
    it('spring forward: 08:00 local is 12:00 UTC after the change, 13:00 UTC before', () => {
      expect(localInstant('2026-03-07', '08:00', NY).toUTC().toISO()).toBe('2026-03-07T13:00:00.000Z');
      expect(localInstant('2026-03-08', '08:00', NY).toUTC().toISO()).toBe('2026-03-08T12:00:00.000Z');
    });

    it('spring forward: a time in the gap (02:30) moves forward to a real instant', () => {
      const dt = localInstant('2026-03-08', '02:30', NY);
      expect(dt.isValid).toBe(true);
      expect(dt.hour).toBe(3);
    });

    it('fall back: 08:00 local is 13:00 UTC after the change, 12:00 UTC before', () => {
      expect(localInstant('2026-10-31', '08:00', NY).toUTC().toISO()).toBe('2026-10-31T12:00:00.000Z');
      expect(localInstant('2026-11-01', '08:00', NY).toUTC().toISO()).toBe('2026-11-01T13:00:00.000Z');
    });

    it('fall back: a repeated time (01:30) resolves to one instant', () => {
      const dt = localInstant('2026-11-01', '01:30', NY);
      expect(dt.isValid).toBe(true);
      expect(dt.toUTC().toISO()).toMatch(/^2026-11-01T0[56]:30:00.000Z$/);
    });

    it('deadlines follow local wall-clock time across the change', () => {
      const meta = { tz: NY, window: { start: '07:00', end: '10:00' }, graceMin: 30, doseGraceMin: 60 };
      expect(checkInDeadline(meta, '2026-03-07')).toBe('2026-03-07T15:30:00.000Z');
      expect(checkInDeadline(meta, '2026-03-08')).toBe('2026-03-08T14:30:00.000Z');
      expect(checkInDeadline(meta, '2026-11-01')).toBe('2026-11-01T15:30:00.000Z');
      expect(doseDeadline(meta, '2026-11-01', '09:00')).toBe('2026-11-01T15:00:00.000Z');
    });

    it('today rolls over at local midnight on the change days', () => {
      expect(todayIn(at('2026-03-08T04:59:00Z'), NY)).toBe('2026-03-07');
      expect(todayIn(at('2026-03-08T05:00:00Z'), NY)).toBe('2026-03-08');
      expect(todayIn(at('2026-11-02T04:59:00Z'), NY)).toBe('2026-11-01');
      expect(todayIn(at('2026-11-02T05:00:00Z'), NY)).toBe('2026-11-02');
    });
  });
});
