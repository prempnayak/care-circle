import { describe, expect, it } from 'vitest';
import { cardDataFrom, renderCard, SAMPLE } from './render';

describe('card render', () => {
  it('shows check-in and dose statuses with labels for screen readers', () => {
    const html = renderCard(SAMPLE);
    expect(html).toContain('Checked in at 8:40 am, feeling okay');
    expect(html).toContain('aria-label="metformin at 8 am: Logged"');
    expect(html).toContain('aria-label="lisinopril at 9 am: Open"');
    expect(html).toContain('not an emergency service');
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
