import { describe, expect, it } from 'vitest';
import { cardDataFrom, renderCard, SAMPLE, withLogged } from './render';

describe('card render', () => {
  it('shows check-in and dose statuses with labels for screen readers', () => {
    const html = renderCard(SAMPLE);
    expect(html).toContain('Checked in at 8:40 am, feeling okay');
    expect(html).toMatch(/metformin · 8 am<\/span><span class="right"><span class="status taken">Logged/);
    expect(html).toMatch(/lisinopril · 9 am<\/span><span class="right"><span class="status open">Open/);
    expect(html).toContain('not an emergency service');
  });

  it('offers tap-to-log only on open doses of the cared-for person\'s own card', () => {
    const own = { ...SAMPLE, canLog: true, doses: SAMPLE.doses.map((d, i) => ({ ...d, doseId: `d${i}` })) };
    const html = renderCard(own);
    expect(html).toContain('data-dose-id="d1"');
    expect(html).toContain('aria-label="Log lisinopril at 9 am"');
    expect(html).not.toContain('data-dose-id="d0"'); // already logged
    expect(renderCard({ ...own, canLog: false })).not.toContain('button');
    expect(renderCard(SAMPLE)).not.toContain('button'); // caregiver cards carry no dose IDs
  });

  it('marks a dose logged after a tap', () => {
    const own = { ...SAMPLE, canLog: true, doses: SAMPLE.doses.map((d, i) => ({ ...d, doseId: `d${i}` })) };
    expect(withLogged(own, 'd1').doses[1]!.status).toBe('taken');
  });

  it('shows only the paused state while sharing is paused', () => {
    const html = renderCard({ ...SAMPLE, paused: true });
    expect(html).toContain('has paused sharing');
    expect(html).not.toContain('metformin');
  });

  it('escapes names', () => {
    expect(renderCard({ ...SAMPLE, recipientName: '<b>x</b>' })).not.toContain('<b>x</b>');
  });

  it('reads card data from structuredContent', () => {
    expect(cardDataFrom({ speech: 'x', today: SAMPLE })).toEqual(SAMPLE);
    expect(cardDataFrom({ speech: 'x' })).toBeNull();
  });
});
