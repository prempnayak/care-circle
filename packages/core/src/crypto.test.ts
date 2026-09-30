import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LocalCrypto } from './crypto';

describe('LocalCrypto', () => {
  const crypto = new LocalCrypto(randomBytes(32).toString('base64'));

  it('round-trips and hides the plaintext', async () => {
    const ct = await crypto.encrypt('bring milk please', 'c1');
    expect(ct).not.toContain('milk');
    expect(await crypto.decrypt(ct, 'c1')).toBe('bring milk please');
  });

  it('binds ciphertext to its circle', async () => {
    const ct = await crypto.encrypt('hello', 'c1');
    await expect(crypto.decrypt(ct, 'c2')).rejects.toThrow();
  });

  it('rejects a bad key', () => {
    expect(() => new LocalCrypto('dG9vLXNob3J0')).toThrow(/32 bytes/);
  });
});
