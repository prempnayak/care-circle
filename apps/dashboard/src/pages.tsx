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

function dateLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
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
        <input id="tz" name="tz" required defaultValue={guessTz} />
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

// ---------------------------------------------------------------- timeline

export function TimelinePage({ circle }: { circle: Circle }) {
  const { data, error } = useLoad(() => api<Timeline>(`/circles/${circle.circleId}/timeline?days=14`), [circle.circleId]);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p role="status">Loading…</p>;
  return (
    <>
      <h2>Last 14 days</h2>
      <p className="hint">Notes and messages appear only here, never read aloud to family members.</p>
      {data.messages.length > 0 && (
        <div className="card">
          <h3>Messages</h3>
          <ul className="plain">
            {data.messages.map((m) => (
              <li key={m.at}>
                <strong>{dateLabel(m.at.slice(0, 10))}, {time(m.at, data.tz)}:</strong> “{m.text}”{m.crisis && <span className="flag"> Urgent wording</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ol className="days">
        {data.days.map((d) => (
          <li key={d.date} className="card">
            <h3>{dateLabel(d.date)}</h3>
            <p>
              <strong>Check-in: </strong>
              {d.checkIn?.status === 'done'
                ? `${time(d.checkIn.at, data.tz)}${d.checkIn.mood ? `, ${MOOD[d.checkIn.mood]}` : ''}`
                : d.checkIn?.status === 'missed'
                  ? 'Missed'
                  : 'Not yet'}
              {d.checkIn?.crisis && <span className="flag"> Urgent wording</span>}
            </p>
            {d.checkIn?.note && <p className="note">Note: “{d.checkIn.note}”</p>}
            {d.doses.length > 0 && (
              <table>
                <caption className="sr-only">Medicines on {dateLabel(d.date)}</caption>
                <thead>
                  <tr>
                    <th scope="col">Medicine</th>
                    <th scope="col">Time</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.doses.map((dose) => (
                    <tr key={`${dose.name}-${dose.time}`}>
                      <td>{dose.name}</td>
                      <td>{dose.time}</td>
                      <td className={`status-${dose.status}`}>
                        {STATUS[dose.status]}
                        {dose.loggedAt ? ` at ${time(dose.loggedAt, data.tz)}` : ''}
                        {dose.late ? ' (late)' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ol>
      {data.alerts.length > 0 && (
        <div className="card">
          <h3>Emails sent</h3>
          <ul className="plain">
            {data.alerts.map((a, i) => (
              <li key={i}>
                {ALERT_NAMES[a.type] ?? a.type}: {a.status}
                {a.sentAt ? `, ${dateLabel(a.sentAt.slice(0, 10))} ${time(a.sentAt, data.tz)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
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
                <td>{m.times.join(', ')}</td>
                {canEdit && (
                  <td>
                    <button onClick={() => void remove(m.medId)} aria-label={`Remove ${m.displayName}`}>
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
              <strong>{m.firstName}</strong> — {m.role === 'admin' ? 'lead caregiver' : m.role === 'member' ? 'family member' : 'the person Care Circle looks after'}
              {m.consentAt && <span className="hint"> · joined {new Date(m.consentAt).toLocaleDateString()}</span>}
              {isAdmin && m.sub !== me.sub && (
                <button onClick={() => void remove(m.sub)} aria-label={`Remove ${m.firstName}`}>
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
      <label htmlFor="s-tz">Time zone</label>
      <input id="s-tz" name="tz" defaultValue={circle.tz} required />
      <label htmlFor="s-start">From</label>
      <input id="s-start" name="start" type="time" defaultValue={circle.window.start} required />
      <label htmlFor="s-end">Until</label>
      <input id="s-end" name="end" type="time" defaultValue={circle.window.end} required />
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
