import { useCallback, useEffect, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";

const AGENT = (
  import.meta.env.VITE_AGENT_URL ?? "http://localhost:8790"
).replace(/\/$/, "");
const MAILPIT = import.meta.env.VITE_MAILPIT_URL ?? "http://localhost:8025";
const DEFAULT_TZ = "America/New_York";

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
  card?: {
    toolName: string;
    structuredContent: Record<string, unknown>;
    resourceUri: string;
    toolResult: unknown;
  };
  needsLinking?: { authorizeUrl: string; resource: string; issuer: string };
  trace: TraceEntry[];
}
interface Line {
  who: "user" | "alexa";
  text: string;
  tools?: { name: string; ok: boolean }[];
}

const SUGGESTIONS: Record<string, string[]> = {
  margaret: [
    "Tell Care Circle I'm up. A bit tired today.",
    "What pills do I have this morning?",
    "I took the metformin",
    "Tell the family I'm going to the park",
    "Tell Care Circle I fell this morning",
    "How much metformin should I take?",
    "Pause sharing",
  ],
  sarah: [
    "Ask Care Circle how Mom's doing",
    "How was Mom's week?",
    "What can you do?",
  ],
  tom: [
    "Ask Care Circle how Mom's doing",
    "How was Mom's week?",
    "What can you do?",
  ],
  new: ["What can you do?", "My code is 482159"],
};

/** "America/New_York" → "New York". */
const city = (tz: string) => tz.split("/").pop()!.replace(/_/g, " ");

function greeting(d: Date, tz: string): string {
  const h = Number(
    d.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz }),
  );
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
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
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AGENT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export function App() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [persona, setPersona] = useState("margaret");
  const [config, setConfig] = useState<{
    agent: string;
    devControls: boolean;
    tz?: string;
  } | null>(null);
  const [panel, setPanel] = useState<"conversation" | "trace">("conversation");
  const [now, setNow] = useState(() => new Date());
  const [lines, setLines] = useState<Record<string, Line[]>>({});
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [showTrace, setShowTrace] = useState(true);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [text, setText] = useState("");
  const [card, setCard] = useState<
    | (TurnResult["card"] & {
        html: string;
        args: Record<string, unknown>;
        seq: number;
      })
    | null
  >(null);
  const [link, setLink] = useState<TurnResult["needsLinking"] | null>(null);
  const [clock, setClock] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const convoRef = useRef<HTMLDivElement>(null);
  const tz = config?.tz ?? DEFAULT_TZ;

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const refreshPersonas = useCallback(async () => {
    try {
      setPersonas(
        (await (await fetch(`${AGENT}/personas`)).json()) as Persona[],
      );
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
      .catch(() =>
        setError(`Can't reach the simulator agent at ${AGENT}. Is it running?`),
      );
  }, [refreshPersonas, refreshClock]);

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
    const c = convoRef.current;
    if (c) c.scrollTop = c.scrollHeight;
  }, [lines, persona, panel]);

  const speak = (s: string) => {
    if (mutedRef.current || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(s);
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  };

  const addLine = (id: string, line: Line) =>
    setLines((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), line] }));

  const handleResult = useCallback(
    async (id: string, result: TurnResult) => {
      setTrace((t) => [...result.trace, ...t].slice(0, 200));
      addLine(id, {
        who: "alexa",
        text: result.reply,
        tools: result.toolCalls.map((t) => ({ name: t.name, ok: !t.isError })),
      });
      speak(result.reply);
      setLink(result.needsLinking ?? null);
      if (result.card) {
        const html = await (await fetch(`${AGENT}/card`)).text();
        const call = result.toolCalls.find(
          (t) => t.name === result.card!.toolName,
        );
        setCard({
          ...result.card,
          html,
          args: call?.args ?? {},
          seq: Date.now(),
        });
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
      addLine(persona, { who: "user", text: said });
      try {
        await handleResult(
          persona,
          await post<TurnResult>("/turn", { persona, text: said }),
        );
      } catch {
        setError("The simulator agent did not answer.");
      } finally {
        setBusy(false);
        setText("");
      }
    },
    [busy, persona, handleResult],
  );

  // After linking in the popup, retry the utterance that got the 401 (as Alexa does).
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (
        e.origin !== new URL(AGENT).origin ||
        (e.data as { type?: string })?.type !== "care-circle-linked"
      )
        return;
      const id = (e.data as { persona: string }).persona;
      setLink(null);
      await refreshPersonas();
      setBusy(true);
      try {
        await handleResult(
          id,
          await post<TurnResult>("/turn", { persona: id, retry: true }),
        );
      } finally {
        setBusy(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refreshPersonas, handleResult]);

  const listen = () => {
    const Ctor = recognizer();
    if (!Ctor) {
      setError("Voice input needs Chrome. You can type instead.");
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e) => void send(e.results[0]?.[0].transcript ?? "");
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const dev = async (action: string, body: unknown = {}, query = "") => {
    setBusy(true);
    try {
      const res = await fetch(`${AGENT}/dev/${action}${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      setTrace((t) => [
        {
          at: new Date().toISOString(),
          kind: "dev",
          label: `demo control: ${action}`,
          status: res.status,
          detail: JSON.stringify(out).slice(0, 160),
        },
        ...t,
      ]);
      if (action === "reset") {
        setLines({});
        setCard(null);
      }
      await refreshClock();
    } finally {
      setBusy(false);
    }
  };

  const current = personas.find((p) => p.id === persona);
  const shown = clock ? new Date(clock) : now;
  const timeLabel = shown.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
  const dateLabel = shown.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
  const convo = lines[persona] ?? [];

  return (
    <div className="layout">
      <header className="topbar">
        <div className="title">
          <span className="logo" aria-hidden="true" />
          <h1>Care Circle</h1>
          <span className="tag">Alexa+ simulator</span>
        </div>
        <div className="row">
          {config && (
            <span
              className="tag"
              title="Which agent picks the tools: scripted rules, or a Bedrock model"
            >
              Agent · {config.agent}
            </span>
          )}
          <span className="tag" title={tz}>
            {clock ? "Demo clock" : "Clock"} · {city(tz)}
          </span>
          <button
            className="icon"
            onClick={() => setMuted((m) => !m)}
            aria-pressed={!muted}
            aria-label="Read replies aloud"
            title={muted ? "Replies are silent" : "Replies are read aloud"}
          >
            <Icon name={muted ? "volumeOff" : "volume"} />
          </button>
          <button
            className="icon"
            onClick={() => setShowTrace((s) => !s)}
            aria-pressed={showTrace}
            aria-label="Side panel"
            title={showTrace ? "Hide side panel" : "Show side panel"}
          >
            <Icon name="panel" />
          </button>
        </div>
      </header>

      <div className="persona-bar">
        <div className="seg" role="group" aria-label="Who's talking">
          {personas.map((p) => (
            <button
              key={p.id}
              className={p.id === persona ? "seg-btn on" : "seg-btn"}
              aria-pressed={p.id === persona}
              onClick={() => {
                setPersona(p.id);
                setLink(null);
              }}
              title={p.hint}
            >
              <span className="avatar" aria-hidden="true">
                {p.id === "new" ? "+" : p.label[0]}
              </span>
              {p.label}
              <span
                className={p.linked ? "dot on" : "dot"}
                aria-hidden="true"
              />
              <span className="sr-only">
                {p.linked ? " (linked)" : " (not linked)"}
              </span>
            </button>
          ))}
        </div>
        {current && (
          <div className="persona-info">
            <span className="muted">{current.hint}</span>
            {current.linked ? (
              <>
                <span className="tag ok">Linked</span>
                <button
                  className="sm"
                  onClick={() =>
                    void post("/unlink", { persona }).then(refreshPersonas)
                  }
                >
                  Unlink
                </button>
              </>
            ) : (
              <span
                className="tag"
                title="Say something and Alexa will ask to link"
              >
                Not linked
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className={showTrace ? "main with-trace" : "main"}>
        <section className="device" aria-label="Echo Show">
          <div className="screen">
            {link ? (
              <div
                className="link-panel"
                role="dialog"
                aria-label="Link your account"
              >
                <div className="qr" aria-hidden="true">
                  {Array.from({ length: 49 }, (_, i) => (
                    <span
                      key={i}
                      className={(i * 7 + (i % 5)) % 3 === 0 ? "on" : ""}
                    />
                  ))}
                </div>
                <div>
                  <h2>Link your account</h2>
                  <p>
                    Care Circle needs {current?.label ?? "you"} to sign in once.
                    On a real Echo Show this happens in the Alexa app.
                  </p>
                  <button
                    className="primary"
                    onClick={() =>
                      window.open(
                        link.authorizeUrl,
                        "care-circle-link",
                        "width=560,height=720",
                      )
                    }
                  >
                    Link account
                  </button>
                  <p className="small muted">
                    Sign-in page: {new URL(link.issuer).host}
                  </p>
                </div>
              </div>
            ) : card ? (
              <CardFrame
                key={card.seq}
                html={card.html}
                toolResult={card.toolResult}
                toolArgs={card.args}
              />
            ) : (
              <div className="idle">
                <p className="greet">
                  {greeting(shown, tz)}
                  {current && current.id !== "new" ? `, ${current.label}` : ""}
                </p>
                <p className="time">{timeLabel}</p>
                <p className="muted">
                  {dateLabel} · {city(tz)}
                </p>
              </div>
            )}
            {busy && (
              <div className="thinking" role="status">
                <span className="ring" aria-hidden="true" /> Alexa is thinking…
              </div>
            )}
            {/* Caption-style: only the latest line on screen; the side panel keeps the whole conversation. */}
            <ol
              className="transcript"
              ref={logRef}
              aria-label="Latest line"
              aria-live="polite"
            >
              {convo.slice(-1).map((l, i) => (
                <li key={i} className={l.who}>
                  <span className="sr-only">
                    {l.who === "user"
                      ? `${current?.label ?? "You"} said: `
                      : "Alexa said: "}
                  </span>
                  {l.text}
                </li>
              ))}
            </ol>
          </div>

          <div className="suggestions" aria-label="Try saying">
            <span className="label">Try saying</span>
            {(SUGGESTIONS[persona] ?? []).map((s) => (
              <button
                key={s}
                className="chip"
                onClick={() => void send(s)}
                disabled={busy}
              >
                {s}
              </button>
            ))}
          </div>

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <button
              type="button"
              className={listening ? "icon live" : "icon"}
              onClick={listen}
              aria-label={listening ? "Listening" : "Speak instead of typing"}
              title={listening ? "Listening…" : "Speak (Chrome)"}
              disabled={busy}
            >
              <Icon name={listening ? "stop" : "mic"} />
            </button>
            <label htmlFor="utterance" className="sr-only">
              What {current?.label ?? "you"} says
            </label>
            <input
              id="utterance"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                persona === "margaret"
                  ? "Type what Margaret says, e.g. I'm up"
                  : "Type what they say, e.g. How's Mom doing?"
              }
              autoComplete="off"
            />
            <button className="primary" disabled={busy || !text.trim()}>
              Say <Icon name="send" size={16} />
            </button>
          </form>

          {config?.devControls && (
            <div className="demo" aria-label="Demo controls">
              <strong>Demo controls</strong>
              <button
                className="sm"
                onClick={() =>
                  void dev("clock", { dayOffset: 0, at: "08:35", tz })
                }
                disabled={busy}
              >
                Today 8:35 am
              </button>
              <button
                className="sm"
                onClick={() =>
                  void dev("clock", { dayOffset: 1, at: "10:35", tz })
                }
                disabled={busy}
              >
                Jump to tomorrow 10:35
              </button>
              <button
                className="sm"
                onClick={() => void dev("sweep")}
                disabled={busy}
              >
                Run sweep now
              </button>
              <button
                className="sm"
                onClick={() => void dev("reset", {}, "?seed=demo")}
                disabled={busy}
              >
                Reset demo
              </button>
              <a href={MAILPIT} target="_blank" rel="noreferrer">
                Open Mailpit inbox
              </a>
            </div>
          )}
        </section>

        {showTrace && (
          <aside className="side" aria-label="Side panel">
            <div
              className="seg full"
              role="tablist"
              aria-label="Side panel view"
            >
              <button
                role="tab"
                aria-selected={panel === "conversation"}
                className={panel === "conversation" ? "seg-btn on" : "seg-btn"}
                onClick={() => setPanel("conversation")}
              >
                Conversation
              </button>
              <button
                role="tab"
                aria-selected={panel === "trace"}
                className={panel === "trace" ? "seg-btn on" : "seg-btn"}
                onClick={() => setPanel("trace")}
              >
                Trace{trace.length > 0 ? ` (${trace.length})` : ""}
              </button>
            </div>
            {panel === "conversation" ? (
              <div
                role="tabpanel"
                aria-label="Conversation"
                tabIndex={0}
                ref={convoRef}
              >
                {convo.length === 0 ? (
                  <div className="empty-state">
                    <p className="empty-title">No conversation yet</p>
                    <p>
                      Pick a suggestion or type below the screen. What{" "}
                      {current?.label ?? "they"} and Alexa say shows up here,
                      with the Care Circle tools that ran.
                    </p>
                  </div>
                ) : (
                  <ol className="convo" aria-label="Conversation history">
                    {convo.map((l, i) => (
                      <li key={i} className={l.who}>
                        <span className="who">
                          {l.who === "user"
                            ? (current?.label ?? "You")
                            : "Alexa"}
                        </span>
                        <span>{l.text}</span>
                        {l.tools && l.tools.length > 0 && (
                          <span className="tools">
                            {l.tools.map((t, j) => (
                              <code
                                key={j}
                                className={t.ok ? "tool" : "tool bad"}
                              >
                                {t.name}
                                {t.ok ? " ✓" : " ✕"}
                              </code>
                            ))}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : (
              <div
                role="tabpanel"
                aria-label="Trace"
                className="trace"
                tabIndex={0}
              >
                {trace.length === 0 ? (
                  <div className="empty-state">
                    <p className="empty-title">No requests yet</p>
                    <p>
                      Say something to see each MCP and OAuth request to the
                      Care Circle server, with its status and time.
                    </p>
                  </div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Request</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="num">
                          ms
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {trace.map((t, i) => {
                        // A 4xx the protocol calls for (e.g. 405 on GET /mcp from a stateless server) is not a failure.
                        const expected =
                          t.detail?.startsWith("expected") ?? false;
                        const detail = expected
                          ? t.detail!.replace(/^expected:\s*/, "")
                          : t.detail;
                        return (
                          <tr
                            key={i}
                            className={`k-${t.kind} ${t.status && t.status >= 400 && !expected ? "bad" : ""}`}
                          >
                            <td>
                              <span className="kind">{t.kind}</span> {t.label}
                              {detail && (
                                <div className="small muted">{detail}</div>
                              )}
                            </td>
                            <td>
                              {t.status ?? ""}
                              {expected && (
                                <span className="tag ok mini">expected</span>
                              )}
                            </td>
                            <td className="num">{t.ms ?? ""}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
