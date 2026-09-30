import { describe, expect, it } from 'vitest';
import { doseIdFor, newJoinCode, parseDoseId } from './keys';

describe('keys', () => {
  it('round-trips dose ids', () => {
    const id = doseIdFor('2026-10-06', '08:00', 'mabc123');
    expect(id).toBe('2026-10-06_0800_mabc123');
    expect(parseDoseId(id)).toEqual({ date: '2026-10-06', time: '08:00', medId: 'mabc123' });
    expect(parseDoseId('nonsense')).toBeNull();
  });

  it('makes 6-digit join codes', () => {
    for (let i = 0; i < 50; i++) expect(newJoinCode()).toMatch(/^\d{6}$/);
  });
});
