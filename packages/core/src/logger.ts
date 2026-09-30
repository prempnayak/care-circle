/**
 * JSON-lines logger that redacts private data. Never log note text, messages, tokens or email addresses;
 * this module removes them even if a caller passes them by mistake (enforced by logger.test.ts).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const REDACT_KEYS = new Set(
  [
    'note',
    'message',
    'text',
    'textcipher',
    'notecipher',
    'token',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'id_token',
    'authorization',
    'cookie',
    'email',
    'emails',
    'to',
    'recipients',
    'code_verifier',
    'code',
    'password',
    'secret',
    'body',
    'arguments',
  ].map((k) => k.toLowerCase()),
);

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export const REDACTED = '[redacted]';

export function redactString(s: string): string {
  return s.replace(BEARER_RE, `Bearer ${REDACTED}`).replace(JWT_RE, REDACTED).replace(EMAIL_RE, REDACTED);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const record = redact({ level, time: new Date().toISOString(), msg, ...base, ...fields });
    sink(JSON.stringify(record));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...base, ...fields }, sink, minLevel),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
