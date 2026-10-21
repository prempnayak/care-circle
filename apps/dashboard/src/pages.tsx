import { useEffect, useState, type FormEvent } from 'react';
import { api, type AlertOptIn, type Circle, type Me, type Medication, type MemberRow, type Timeline } from './api';

const MOOD: Record<string, string> = { good: 'Good', okay: 'Okay', not_great: 'Not great' };
const STATUS: Record<string, string> = { taken: 'Logged', skipped: 'Skipped', open: 'Open', missed: 'Not logged', done: 'Checked in' };
const ALERT_NAMES: Record<string, string> = {
  missed_checkin: 'Missed check-in email',
  missed_dose: 'Missed medicine email',
  crisis: 'Urgent wording email',
  message: 'Message email',
  all_clear: 'All-clear email',
  sharing_changed: 'Sharing change email',
};

function time(iso: string | null, tz: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
}

/** A calendar date (YYYY-MM-DD, already in the circle's time zone). */
function dayLabel(date: string, style: 'short' | 'long' = 'short'): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: style, month: style, day: 'numeric', timeZone: 'UTC' });
}

/** The date of an instant, in the circle's time zone (not UTC). */
function shortDate(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
}

/** "08:00" → "8:00 AM". */
export function hm(t: string): string {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "America/New_York" → "New York time (Eastern Daylight Time)". */
export function tzName(tz: string): string {
  const city = tz.split('/').pop()!.replace(/_/g, ' ');
  const long = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
  return long ? `${city} time (${long})` : `${city} time`;
}

const TIME_ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
  }
})();

function TimeZoneInput({ id, defaultValue }: { id: string; defaultValue: string }) {
  return (
    <>
      <input id={id} name="tz" list={`${id}-list`} required defaultValue={defaultValue} autoComplete="off" />
      <datalist id={`${id}-list`}>
        {TIME_ZONES.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </>
  );
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn()
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

// ---------------------------------------------------------------- create circle

export function CreateCirclePage({ onCreated }: { onCreated: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guessTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/circles', {
        method: 'POST',
        body: {
          recipientFirstName: String(f.get('name')),
          tz: String(f.get('tz')),
          window: { start: String(f.get('start')), end: String(f.get('end')) },
          graceMin: Number(f.get('grace')),
        },
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Create a circle</h1>
      <p className="lead">Set up Care Circle for the person you look after. You can add medicines and invite family next.</p>
      <form onSubmit={submit} className="card">
        <label htmlFor="name">Their first name</label>
        <input id="name" name="name" required maxLength={40} autoComplete="off" />
        <label htmlFor="tz">Time zone</label>
        <TimeZoneInput id="tz" defaultValue={guessTz} />
        <fieldset>
          <legend>Morning check-in window</legend>
          <label htmlFor="start">From</label>
          <input id="start" name="start" type="time" required defaultValue="07:00" />
          <label htmlFor="end">Until</label>
          <input id="end" name="end" type="time" required defaultValue="10:00" />
        </fieldset>
        <label htmlFor="grace">Minutes to wait after the window before emailing the family</label>
        <input id="grace" name="grace" type="number" min={0} max={180} defaultValue={30} required />
        {error && <p role="alert" className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          Create circle
        </button>
      </form>
    </>
  );
}

// ---------------------------------------------------------------- overview (today + history)

const MAX_MESSAGES = 5;

export function TimelinePage({ circle }: { circle: Circle }) {
  const { data, error } = useLoad(() => api<Timeline>(`/circles/${circle.circleId}/timeline?days=14`), [circle.circleId]);
  const [allMessages, setAllMessages] = useState(false);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p role="status">Loading…</p>;
  const [today, ...history] = data.days;
  const name = circle.recipientFirstName;
  const messages = allMessages ? data.messages : data.messages.slice(0, MAX_MESSAGES);
  return (
    <>
      <p className="tz-note">
        All times are {name}'s time: <strong>{tzName(data.tz)}</strong>.
      </p>
      {today && <TodayCard day={today} tz={data.tz} circle={circle} />}

      <section className="card" aria-labelledby="msg-h">
        <h2 id="msg-h">Messages</h2>
        <p className="hint">
          {name}'s notes and messages appear only here, never read aloud to family. Messages to {name} are read to {name} at the next check-in.
        </p>
        {data.messages.length === 0 ? (
          <p className="empty">No messages in the last 14 days.</p>
        ) : (
          <ul className="messages">
            {messages.map((m) => (
              <li key={m.at}>
                <span className="when">{shortDate(m.at, data.tz)}, {time(m.at, data.tz)}</span>
                <span className="text">
                  <span className="from">{m.toRecipient ? `${m.from} to ${name}` : m.from}</span> “{m.text}”
                </span>
                {m.crisis && <span className="pill bad">Urgent wording</span>}
              </li>
            ))}
          </ul>
        )}
        {data.messages.length > MAX_MESSAGES && (
          <button className="link" onClick={() => setAllMessages((v) => !v)}>
            {allMessages ? 'Show fewer' : `Show all ${data.messages.length} messages`}
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="hist-h">
        <h2 id="hist-h">Last 14 days</h2>
        <table className="history">
          <caption className="sr-only">Check-ins and medicines by day, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Check-in</th>
              <th scope="col">Medicines</th>
            </tr>
          </thead>
          <tbody>
            {history.map((d) => (
              <tr key={d.date}>
                <th scope="row">{dayLabel(d.date)}</th>
                <td>
                  <CheckInPill day={d} tz={data.tz} />
                  {d.checkIn?.note && <div className="note">“{d.checkIn.note}”</div>}
                </td>
                <td>
                  {d.doses.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <ul className="pills">
                      {d.doses.map((dose) => (
                        <li key={`${dose.name}-${dose.time}`}>
                          <DosePill dose={dose} tz={data.tz} />
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {data.alerts.length > 0 && (
        <section className="card" aria-labelledby="alerts-h">
          <h2 id="alerts-h">Emails sent to the family</h2>
          <ul className="messages">
            {data.alerts.slice(0, 10).map((a, i) => (
              <li key={i}>
                <span className="when">{a.sentAt ? `${shortDate(a.sentAt, data.tz)}, ${time(a.sentAt, data.tz)}` : 'Waiting to send'}</span>
                <span className="text">{ALERT_NAMES[a.type] ?? a.type}</span>
                {a.status !== 'sent' && <span className="pill">{a.status}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

type Day = Timeline['days'][number];
type Dose = Day['doses'][number];

function TodayCard({ day, tz, circle }: { day: Day; tz: string; circle: Circle }) {
  const logged = day.doses.filter((d) => d.status === 'taken' || d.status === 'skipped').length;
  const ci = day.checkIn;
  const window = `${hm(circle.window.start)}–${hm(circle.window.end)}`;
  return (
    <section className="card today" aria-labelledby="today-h">
      <h2 id="today-h">Today · {dayLabel(day.date, 'long')}</h2>
      <div className="tiles">
        <div className={`tile ${ci?.status === 'done' ? 'ok' : ci?.status === 'missed' ? 'bad' : 'wait'}`}>
          <h3>Check-in</h3>
          {ci?.status === 'done' ? (
            <p className="big">
              <span aria-hidden="true">✓ </span>Checked in at {time(ci.at, tz)}
            </p>
          ) : ci?.status === 'missed' ? (
            <p className="big">
              <span aria-hidden="true">! </span>No check-in this morning
            </p>
          ) : (
            <p className="big">Not yet</p>
          )}
          <p className="sub">
            {ci?.mood ? `Feeling: ${MOOD[ci.mood]}` : `Check-in window ${window}`}
            {ci?.crisis && <span className="pill bad">Urgent wording</span>}
          </p>
          {ci?.note && <p className="note">“{ci.note}”</p>}
        </div>
        <div className={`tile ${day.doses.length === 0 ? '' : logged === day.doses.length ? 'ok' : day.doses.some((d) => d.status === 'missed') ? 'bad' : 'wait'}`}>
          <h3>Medicines</h3>
          {day.doses.length === 0 ? (
            <p className="big">None scheduled</p>
          ) : (
            <>
              <p className="big">
                {logged} of {day.doses.length} logged
              </p>
              <ul className="pills">
                {day.doses.map((dose) => (
                  <li key={`${dose.name}-${dose.time}`}>
                    <DosePill dose={dose} tz={tz} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function CheckInPill({ day, tz }: { day: Day; tz: string }) {
  const ci = day.checkIn;
  if (ci?.status === 'done')
    return (
      <span className="pill ok">
        <span aria-hidden="true">✓ </span>
        {time(ci.at, tz)}
        {ci.mood ? ` · ${MOOD[ci.mood]}` : ''}
        {ci.crisis ? ' · Urgent wording' : ''}
      </span>
    );
  if (ci?.status === 'missed')
    return (
      <span className="pill bad">
        <span aria-hidden="true">✕ </span>Missed
      </span>
    );
  return <span className="muted">—</span>;
}

function DosePill({ dose, tz }: { dose: Dose; tz: string }) {
  const cls = dose.status === 'taken' || dose.status === 'skipped' ? 'ok' : dose.status === 'missed' ? 'bad' : 'wait';
  const icon = cls === 'ok' ? '✓ ' : cls === 'bad' ? '✕ ' : '○ ';
  const detail = dose.loggedAt ? `${STATUS[dose.status]} ${time(dose.loggedAt, tz)}${dose.late ? ', late' : ''}` : STATUS[dose.status];
  return (
    <span className={`pill ${cls}`} title={`${dose.name} at ${hm(dose.time)}: ${detail}`}>
      <span aria-hidden="true">{icon}</span>
      {dose.name} {hm(dose.time)}
      <span className="sr-only">: {detail}</span>
    </span>
  );
}

// ---------------------------------------------------------------- medications

export function MedicationsPage({ circle, canEdit }: { circle: Circle; canEdit: boolean }) {
  const { data, error, reload } = useLoad(() => api<Medication[]>(`/circles/${circle.circleId}/medications`), [circle.circleId]);
  const [formError, setFormError] = useState<string | null>(null);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setFormError(null);
    try {
      await api(`/circles/${circle.circleId}/medications`, {
        method: 'POST',
        body: {
          displayName: String(f.get('name')),
          aliases: String(f.get('aliases') ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          times: String(f.get('times'))
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      form.reset();
      reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  async function remove(medId: string) {
    await api(`/circles/${circle.circleId}/medications/${medId}`, { method: 'DELETE' });
    reload();
  }

  if (error) return <p role="alert" className="error">{error}</p>;
  return (
    <>
      <h2>Medicines</h2>
      <p className="hint">Care Circle stores only a name, nicknames and times. No doses, strengths or drug information.</p>
      {!data ? (
        <p role="status">Loading…</p>
      ) : data.length === 0 ? (
        <p>No medicines yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Also called</th>
              <th scope="col">Times</th>
              {canEdit && <th scope="col"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.medId}>
                <td>{m.displayName}</td>
                <td>{m.aliases.join(', ') || '—'}</td>
                <td>{m.times.map(hm).join(', ')}</td>
                {canEdit && (
                  <td>
                    <button className="small" onClick={() => void remove(m.medId)} aria-label={`Remove ${m.displayName}`}>
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canEdit && (
        <form onSubmit={add} className="card">
          <h3>Add a medicine</h3>
          <label htmlFor="med-name">Name, as it's said aloud</label>
          <input id="med-name" name="name" required maxLength={40} placeholder="metformin" />
          <label htmlFor="med-aliases">Nicknames (comma separated, optional)</label>
          <input id="med-aliases" name="aliases" maxLength={200} placeholder="diabetes pill" />
          <label htmlFor="med-times">Times, 24-hour, comma separated</label>
          <input id="med-times" name="times" required pattern="^([01]\d|2[0-3]):[0-5]\d(\s*,\s*([01]\d|2[0-3]):[0-5]\d)*$" placeholder="08:00, 20:00" />
          {formError && <p role="alert" className="error">{formError}</p>}
          <button className="primary">Add medicine</button>
        </form>
      )}
    </>
  );
}

// ---------------------------------------------------------------- members and codes

export function MembersPage({ circle, me, onChange }: { circle: Circle; me: Me; onChange: () => void }) {
  const { data, error, reload } = useLoad(() => api<MemberRow[]>(`/circles/${circle.circleId}/members`), [circle.circleId]);
  const [code, setCode] = useState<{ code: string; role: string; expiresAt: string } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const isAdmin = me.membership?.role === 'admin';

  async function makeCode(role: 'recipient' | 'member') {
    setCodeError(null);
    try {
      setCode(await api(`/circles/${circle.circleId}/codes`, { method: 'POST', body: { role } }));
    } catch (err) {
      setCodeError((err as Error).message === 'recipient_already_joined' ? `${circle.recipientFirstName} has already joined.` : (err as Error).message);
    }
  }

  async function remove(sub: string) {
    await api(`/circles/${circle.circleId}/members/${sub}`, { method: 'DELETE' });
    reload();
    onChange();
  }

  return (
    <>
      <h2>Family</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {data && (
        <ul className="plain">
          {data.map((m) => (
            <li key={m.sub}>
              <strong>{m.firstName}</strong>
              <span className="pill">{m.role === 'admin' ? 'Lead caregiver' : m.role === 'member' ? 'Family member' : 'Care Circle looks after'}</span>
              {m.consentAt && <span className="hint">Joined {new Date(m.consentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
              {isAdmin && m.sub !== me.sub && (
                <button className="small push" onClick={() => void remove(m.sub)} aria-label={`Remove ${m.firstName}`}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isAdmin && (
        <div className="card">
          <h3>Invite with a join code</h3>
          <p className="hint">
            Each person links their own Amazon account, then says: “Alexa, tell Care Circle my code is …”. Codes work once and last 24 hours.
          </p>
          <div className="row">
            {!circle.hasRecipient && (
              <button className="primary" onClick={() => void makeCode('recipient')}>
                Code for {circle.recipientFirstName}
              </button>
            )}
            <button className="primary" onClick={() => void makeCode('member')}>
              Code for a family member
            </button>
          </div>
          {codeError && <p role="alert" className="error">{codeError}</p>}
          {code && (
            <p role="status" className="code">
              Join code <strong aria-label={code.code.split('').join(' ')}>{code.code}</strong> for{' '}
              {code.role === 'recipient' ? circle.recipientFirstName : 'a family member'}. It expires {new Date(code.expiresAt).toLocaleString()}.
            </p>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- alerts

export function AlertsPage({ circle, me }: { circle: Circle; me: Me }) {
  const { data, error, reload } = useLoad(() => api<MemberRow[]>(`/circles/${circle.circleId}/members`), [circle.circleId]);
  const [saved, setSaved] = useState<string | null>(null);
  const editable = (data ?? []).filter((m) => m.role !== 'recipient' && m.alertOptIn);

  async function toggle(m: MemberRow, key: keyof AlertOptIn) {
    const next = { ...m.alertOptIn!, [key]: !m.alertOptIn![key] };
    await api(`/circles/${circle.circleId}/members/${m.sub}/alerts`, { method: 'PATCH', body: next });
    setSaved(`Saved ${m.firstName}'s email settings.`);
    reload();
  }

  if (me.membership?.role === 'recipient') return <p>Email alerts go to your family members.</p>;
  if (error) return <p role="alert" className="error">{error}</p>;
  const labels: [keyof AlertOptIn, string][] = [
    ['missedCheckIn', `${circle.recipientFirstName} hasn't checked in`],
    ['missedDose', 'A medicine isn’t logged an hour after its time'],
    ['crisis', 'Urgent wording (a fall, chest pain, or thoughts of self-harm)'],
    ['message', `Messages from ${circle.recipientFirstName}`],
  ];
  return (
    <>
      <h2>Email alerts</h2>
      <p className="hint">Care Circle emails only facts, never health judgments. Every email says it is not an emergency service.</p>
      {saved && <p role="status">{saved}</p>}
      {editable.map((m) => (
        <fieldset key={m.sub} className="card">
          <legend>{m.firstName}</legend>
          {labels.map(([key, label]) => (
            <label key={key} className="check">
              <input type="checkbox" checked={m.alertOptIn![key]} onChange={() => void toggle(m, key)} /> {label}
            </label>
          ))}
        </fieldset>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- settings

export function SettingsPage({ circle, onSaved }: { circle: Circle; onSaved: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api(`/circles/${circle.circleId}`, {
        method: 'PATCH',
        body: {
          window: { start: String(f.get('start')), end: String(f.get('end')) },
          graceMin: Number(f.get('grace')),
          tz: String(f.get('tz')),
        },
      });
      setMsg('Saved.');
      onSaved();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }
  return (
    <form onSubmit={submit} className="card">
      <h2>Check-in window</h2>
      <p className="hint">
        If {circle.recipientFirstName} hasn't checked in by the end of the window, Care Circle waits the extra minutes below, then emails the family.
      </p>
      <label htmlFor="s-tz">Time zone</label>
      <TimeZoneInput id="s-tz" defaultValue={circle.tz} />
      <p className="hint">Now: {tzName(circle.tz)}. Every time on this dashboard and in Alexa's replies uses it.</p>
      <div className="two">
        <div>
          <label htmlFor="s-start">From</label>
          <input id="s-start" name="start" type="time" defaultValue={circle.window.start} required />
        </div>
        <div>
          <label htmlFor="s-end">Until</label>
          <input id="s-end" name="end" type="time" defaultValue={circle.window.end} required />
        </div>
      </div>
      <label htmlFor="s-grace">Minutes to wait before emailing</label>
      <input id="s-grace" name="grace" type="number" min={0} max={180} defaultValue={circle.graceMin} required />
      {msg && <p role="status">{msg}</p>}
      <button className="primary">Save</button>
    </form>
  );
}

// ---------------------------------------------------------------- account

export function AccountPage({ me, circle, onDeleted }: { me: Me; circle: Circle; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const removesCircle = me.membership?.role === 'recipient' || circle.createdBy === me.sub;
  return (
    <div className="card">
      <h2>Your account</h2>
      <p>
        {me.firstName}
        {me.email ? ` · ${me.email}` : ''}
      </p>
      <h3>Delete account</h3>
      <p>
        {removesCircle
          ? `This deletes your account and all of ${circle.recipientFirstName}'s circle data: check-ins, medicines, notes and messages.`
          : 'This deletes your account and removes you from the circle.'}
      </p>
      {!confirming ? (
        <button onClick={() => setConfirming(true)}>Delete my account…</button>
      ) : (
        <div className="row">
          <button
            className="danger"
            onClick={async () => {
              await api('/me', { method: 'DELETE' });
              onDeleted();
            }}
          >
            Yes, delete everything
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
