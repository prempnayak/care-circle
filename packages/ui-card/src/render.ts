/**
 * Renders the card from the tool's structuredContent.today, the same data the speech came from,
 * so the card and the voice reply can never disagree. Read-only in the MVP.
 */
export interface CardData {
  recipientName: string;
  date: string;
  dateLabel: string;
  paused: boolean;
  checkIn: { status: 'done' | 'open' | 'missed'; at?: string; mood?: 'good' | 'okay' | 'not_great' };
  doses: { name: string; time: string; status: 'open' | 'taken' | 'skipped' | 'missed' }[];
}

const MOOD: Record<string, string> = { good: 'feeling good', okay: 'feeling okay', not_great: 'not feeling great' };
const DOSE_STATUS: Record<CardData['doses'][number]['status'], string> = {
  taken: 'Logged',
  skipped: 'Skipped',
  open: 'Open',
  missed: 'Not logged',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeLabel(t: string): string {
  return /pm$/.test(t) ? t : `${t} am`;
}

export function renderCard(data: CardData): string {
  const name = esc(data.recipientName);
  if (data.paused) {
    return `<h1>${name}</h1><p class="date">${esc(data.dateLabel)}</p>
<section aria-label="Sharing"><p class="paused">${name} has paused sharing.</p></section>
<p class="footer">Care Circle is not an emergency service. In an emergency, call 911.</p>`;
  }
  let checkIn: string;
  if (data.checkIn.status === 'done') {
    const mood = data.checkIn.mood ? `, ${MOOD[data.checkIn.mood]}` : '';
    checkIn = `<span class="status done">Checked in at ${esc(timeLabel(data.checkIn.at ?? ''))}${esc(mood)}</span>`;
  } else if (data.checkIn.status === 'missed') {
    checkIn = `<span class="status missed">No check-in today</span>`;
  } else {
    checkIn = `<span class="status open">Not yet</span>`;
  }
  const doses =
    data.doses.length === 0
      ? '<p>No medicines listed for today.</p>'
      : `<ul aria-label="Today's medicines">${data.doses
          .map(
            (d) =>
              `<li aria-label="${esc(d.name)} at ${esc(timeLabel(d.time))}: ${DOSE_STATUS[d.status]}"><span>${esc(d.name)} · ${esc(
                timeLabel(d.time),
              )}</span><span class="status ${d.status}">${DOSE_STATUS[d.status]}</span></li>`,
          )
          .join('')}</ul>`;
  return `<h1>${name}</h1><p class="date">${esc(data.dateLabel)}</p>
<section aria-label="Check-in"><h2>Check-in</h2><p>${checkIn}</p></section>
<section aria-label="Medicines"><h2>Medicines</h2>${doses}</section>
<p class="footer">Care Circle is not an emergency service. In an emergency, call 911.</p>`;
}

/** Pull card data out of a tool result's structuredContent, if present. */
export function cardDataFrom(structured: unknown): CardData | null {
  const today = (structured as { today?: CardData } | null)?.today;
  return today && typeof today.recipientName === 'string' ? today : null;
}

export const SAMPLE: CardData = {
  recipientName: 'Margaret',
  date: '2026-10-06',
  dateLabel: 'Tuesday, October 6',
  paused: false,
  checkIn: { status: 'done', at: '8:40', mood: 'okay' },
  doses: [
    { name: 'metformin', time: '8', status: 'taken' },
    { name: 'lisinopril', time: '9', status: 'open' },
  ],
};
