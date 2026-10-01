import { useCallback, useEffect, useRef, useState } from 'react';
import { CardFrame } from './CardFrame';

const AGENT = (import.meta.env.VITE_AGENT_URL ?? 'http://localhost:8790').replace(/\/$/, '');
const MAILPIT = import.meta.env.VITE_MAILPIT_URL ?? 'http://localhost:8025';
const DEMO_TZ = 'America/New_York';

interface Persona {
  id: string;
  label: string;
  hint: string;
  linked: boolean;
}
interface TraceEntry {
  at: string;
  kind: string;
  label: string;
  status?: number;
  ms?: number;
  detail?: string;
}
interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  status: number;
  isError: boolean;
  speech: string;
}
interface TurnResult {
  reply: string;
  toolCalls: ToolCall[];
  card?: { toolName: string; structuredContent: Record<string, unknown>; resourceUri: string; toolResult: unknown };
  needsLinking?: { authorizeUrl: string; resource: string; issuer: string };
  trace: TraceEntry[];
}
interface Line {
  who: 'user' | 'alexa';
  text: string;
}

type SpeechRecognitionCtor = new () => {
  lang: string;
  interimResults: boolean;
  onresult: (e: { results: { 0: { transcript: string } }[] }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
};

function recognizer(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AGENT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}

export function App() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [persona, setPersona] = useState('margaret');
  const [config, setConfig] = useState<{ agent: string; devControls: boolean } | null>(null);
  const [lines, setLines] = useState<Record<string, Line[]>>({});
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [showTrace, setShowTrace] = useState(true);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [text, setText] = useState('');
  const [card, setCard] = useState<(TurnResult['card'] & { html: string; args: Record<string, unknown>; seq: number }) | null>(null);
  const [link, setLink] = useState<TurnResult['needsLinking'] | null>(null);
  const [clock, setClock] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const refreshPersonas = useCallback(async () => {
    try {
      setPersonas((await (await fetch(`${AGENT}/personas`)).json()) as Persona[]);
    } catch {
      setError(`Can't reach the simulator agent at ${AGENT}. Is it running?`);
    }
  }, []);

  const refreshClock = useCallback(async () => {
    try {
      const res = await fetch(`${AGENT}/dev/clock`);
      if (res.ok) setClock(((await res.json()) as { now: string }).now);
    } catch {
      // dev controls off
    }
  }, []);

  useEffect(() => {
    void refreshPersonas();
    fetch(`${AGENT}/config`)
      .then((r) => r.json())
      .then((c) => {
        setConfig(c);
        if (c.devControls) void refreshClock();
      })
      .catch(() => setError(`Can't reach the simulator agent at ${AGENT}. Is it running?`));
  }, [refreshPersonas, refreshClock]);

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: 'end' });
  }, [lines, persona]);

  const speak = (s: string) => {
    if (mutedRef.current || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(s);
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  };

  const addLine = (id: string, line: Line) => setLines((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), line] }));

  const handleResult = useCallback(
    async (id: string, result: TurnResult) => {
      setTrace((t) => [...result.trace, ...t].slice(0, 200));
      addLine(id, { who: 'alexa', text: result.reply });
      speak(result.reply);
      setLink(result.needsLinking ?? null);
      if (result.card) {
        const html = await (await fetch(`${AGENT}/card`)).text();
        const call = result.toolCalls.find((t) => t.name === result.card!.toolName);
        setCard({ ...result.card, html, args: call?.args ?? {}, seq: Date.now() });
      }
      void refreshPersonas();
    },
    [refreshPersonas],
  );

  const send = useCallback(
    async (utterance: string) => {
      const said = utterance.trim();
      if (!said || busy) return;
      setBusy(true);
      setError(null);
      addLine(persona, { who: 'user', text: said });
      try {
        await handleResult(persona, await post<TurnResult>('/turn', { persona, text: said }));
      } catch {
        setError('The simulator agent did not answer.');
      } finally {
        setBusy(false);
        setText('');
      }
    },
    [busy, persona, handleResult],
  );

  // After linking in the popup, retry the utterance that got the 401 (as Alexa does).
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== new URL(AGENT).origin || (e.data as { type?: string })?.type !== 'care-circle-linked') return;
      const id = (e.data as { persona: string }).persona;
      setLink(null);
      await refreshPersonas();
      setBusy(true);
      try {
        await handleResult(id, await post<TurnResult>('/turn', { persona: id, retry: true }));
      } finally {
        setBusy(false);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refreshPersonas, handleResult]);

  const listen = () => {
    const Ctor = recognizer();
    if (!Ctor) {
      setError('Voice input needs Chrome. You can type instead.');
      return;
    }
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.onresult = (e) => void send(e.results[0]?.[0].transcript ?? "");
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const dev = async (action: string, body: unknown = {}, query = '') => {
    setBusy(true);
    try {
      const res = await fetch(`${AGENT}/dev/${action}${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json();
      setTrace((t) => [{ at: new Date().toISOString(), kind: 'dev', label: `demo control: ${action}`, status: res.status, detail: JSON.stringify(out).slice(0, 160) }, ...t]);
      if (action === 'reset') {
        setLines({});
        setCard(null);
      }
      await refreshClock();
    } finally {
      setBusy(false);
    }
  };

  const current = personas.find((p) => p.id === persona);
  const clockLabel = clock
    ? new Date(clock).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: DEMO_TZ, timeZoneName: 'short' })
    : null;

  return (
    <div className="layout">
      <header>
        <h1>
          Care Circle <span className="muted">· Alexa+ simulator</span>
        </h1>
        <div className="row">
          {config && <span className="badge">agent: {config.agent}</span>}
          {clockLabel && <span className="badge">demo clock: {clockLabel}</span>}
          <button onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <button onClick={() => setShowTrace((s) => !s)} aria-pressed={showTrace}>
            {showTrace ? 'Hide trace' : 'Show trace'}
          </button>
        </div>
      </header>

      <nav className="personas" aria-label="Personas">
        {personas.map((p) => (
          <button
            key={p.id}
            className={p.id === persona ? 'persona active' : 'persona'}
            onClick={() => {
              setPersona(p.id);
              setLink(null);
            }}
            title={p.hint}
          >
            <span className={p.linked ? 'dot on' : 'dot'} aria-hidden="true" />
            {p.label}
            <span className="sr-only">{p.linked ? ' (linked)' : ' (not linked)'}</span>
          </button>
        ))}
        {current?.linked && (
          <button className="link-btn" onClick={() => void post('/unlink', { persona }).then(refreshPersonas)}>
            Unlink {current.label}
          </button>
        )}
      </nav>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className={showTrace ? 'main with-trace' : 'main'}>
        <section className="device" aria-label="Echo Show">
          <div className="screen">
            {link ? (
              <div className="link-panel" role="dialog" aria-label="Link your account">
                <div className="qr" aria-hidden="true">
                  {Array.from({ length: 49 }, (_, i) => (
                    <span key={i} className={(i * 7 + (i % 5)) % 3 === 0 ? 'on' : ''} />
                  ))}
                </div>
                <div>
                  <h2>Link your account</h2>
                  <p>Care Circle needs you to sign in. On a real device this happens in the Alexa app.</p>
                  <button className="primary" onClick={() => window.open(link.authorizeUrl, 'care-circle-link', 'width=560,height=720')}>
                    Link account
                  </button>
                  <p className="small muted">Auth server: {link.issuer}</p>
                </div>
              </div>
            ) : card ? (
              <CardFrame key={card.seq} html={card.html} toolResult={card.toolResult} toolArgs={card.args} />
            ) : (
              <div className="idle">
                <p className="time">{clockLabel ?? new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
                <p className="muted">Say “Alexa, tell Care Circle I'm up”.</p>
              </div>
            )}
            <ol className="transcript" ref={logRef} aria-live="polite" aria-label="Conversation" tabIndex={0}>
              {(lines[persona] ?? []).slice(-2).map((l, i) => (
                <li key={i} className={l.who}>
                  <span className="sr-only">{l.who === 'user' ? `${current?.label ?? 'You'} said: ` : 'Alexa said: '}</span>
                  {l.text}
                </li>
              ))}
            </ol>
          </div>

          <form
            className="say"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <button type="button" className={listening ? 'mic on' : 'mic'} onClick={listen} aria-label="Speak" disabled={busy}>
              {listening ? '●' : '🎤'}
            </button>
            <label htmlFor="utterance" className="sr-only">
              What {current?.label ?? 'you'} says
            </label>
            <input
              id="utterance"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={persona === 'margaret' ? "Alexa, tell Care Circle I'm up" : "Alexa, ask Care Circle how Mom's doing"}
              autoComplete="off"
            />
            <button className="primary" disabled={busy || !text.trim()}>
              Say
            </button>
          </form>

          <div className="suggestions" aria-label="Try saying">
            {(persona === 'margaret'
              ? ["Tell Care Circle I'm up. A bit tired today.", 'What pills do I have this morning?', 'I took the metformin', 'Tell Care Circle I fell this morning', 'How much metformin should I take?', 'Pause sharing']
              : persona === 'new'
                ? ['What can you do?', 'My code is 482159']
                : ["Ask Care Circle how Mom's doing", "How was Mom's week?", 'What can you do?']
            ).map((s) => (
              <button key={s} className="chip" onClick={() => void send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>

          {config?.devControls && (
            <div className="demo" aria-label="Demo controls">
              <strong>Demo controls</strong>
              <button onClick={() => void dev('clock', { dayOffset: 0, at: '08:35', tz: DEMO_TZ })} disabled={busy}>
                Today 8:35 am
              </button>
              <button onClick={() => void dev('clock', { dayOffset: 1, at: '10:35', tz: DEMO_TZ })} disabled={busy}>
                Jump to tomorrow 10:35
              </button>
              <button onClick={() => void dev('sweep')} disabled={busy}>
                Run sweep now
              </button>
              <button onClick={() => void dev('reset', {}, '?seed=demo')} disabled={busy}>
                Reset demo
              </button>
              <a href={MAILPIT} target="_blank" rel="noreferrer">
                Open Mailpit inbox
              </a>
            </div>
          )}
        </section>

        {showTrace && (
          <aside className="trace" aria-label="Trace" tabIndex={0}>
            <h2>Trace</h2>
            <p className="small muted">Each MCP and OAuth request: what was called, HTTP status, latency.</p>
            <table>
              <thead>
                <tr>
                  <th scope="col">Request</th>
                  <th scope="col">Status</th>
                  <th scope="col">ms</th>
                </tr>
              </thead>
              <tbody>
                {trace.map((t, i) => (
                  <tr key={i} className={`k-${t.kind} ${t.status && t.status >= 400 && !t.detail?.startsWith('expected') ? 'bad' : ''}`}>
                    <td>
                      <span className="kind">{t.kind}</span> {t.label}
                      {t.detail && <div className="small muted">{t.detail}</div>}
                    </td>
                    <td>{t.status ?? ''}</td>
                    <td>{t.ms ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>
        )}
      </div>
    </div>
  );
}
