import { describe, expect, it } from 'vitest';
import { createLogger, redact, REDACTED } from './logger';

describe('logger redaction (privacy gate)', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJlLXZhbHVl';

  it('never writes note text, messages, tokens or email addresses', () => {
    const lines: string[] = [];
    const log = createLogger({}, (l) => lines.push(l), 'debug');
    log.info('tool call', {
      tool: 'check_in',
      args: { mood: 'okay', note: 'my secret note' },
      message: 'please bring milk',
      headers: { authorization: `Bearer ${jwt}` },
      user: { email: 'sarah@example.com', sub: 'abc' },
      detail: `failed for sarah@example.com with ${jwt}`,
      refresh_token: 'r-123',
    });
    const out = lines.join('\n');
    expect(out).not.toContain('my secret note');
    expect(out).not.toContain('please bring milk');
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('sarah@example.com');
    expect(out).not.toContain('r-123');
    expect(out).toContain('"tool":"check_in"');
    expect(out).toContain('"mood":"okay"');
    expect(out).toContain('"sub":"abc"');
  });

  it('redacts error messages', () => {
    const r = redact({ err: new Error('bad token eyJabcdefg.eyJhijklmn.sig for tom@example.org') }) as { err: { message: string } };
    expect(r.err.message).not.toContain('tom@example.org');
    expect(r.err.message).toContain(REDACTED);
  });

  it('respects the minimum level', () => {
    const lines: string[] = [];
    const log = createLogger({}, (l) => lines.push(l), 'warn');
    log.info('hidden');
    log.warn('shown');
    expect(lines).toHaveLength(1);
  });
});
