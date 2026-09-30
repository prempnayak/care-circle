import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';

/** Field-level encryption for note and message text. The circle id binds each ciphertext to its circle. */
export interface Crypto {
  encrypt(plaintext: string, circleId: string): Promise<string>;
  decrypt(ciphertext: string, circleId: string): Promise<string>;
}

/** AES-256-GCM with a key from LOCAL_DATA_KEY (32 bytes, base64). Local mode only. */
export class LocalCrypto implements Crypto {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('LOCAL_DATA_KEY must be 32 bytes, base64-encoded (run npm run gen:key)');
  }

  async encrypt(plaintext: string, circleId: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(circleId, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.local.${iv.toString('base64')}.${Buffer.concat([ct, tag]).toString('base64')}`;
  }

  async decrypt(ciphertext: string, circleId: string): Promise<string> {
    const [v, kind, ivB64, dataB64] = ciphertext.split('.');
    if (v !== 'v1' || kind !== 'local' || !ivB64 || !dataB64) throw new Error('Unsupported ciphertext');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(circleId, 'utf8'));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
  }
}

/** KMS Encrypt/Decrypt with the table's customer-managed key and an encryption context of {circleId}. */
export class KmsCrypto implements Crypto {
  constructor(
    private readonly keyId: string,
    private readonly client = new KMSClient({}),
  ) {}

  async encrypt(plaintext: string, circleId: string): Promise<string> {
    const out = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: Buffer.from(plaintext, 'utf8'),
        EncryptionContext: { circleId },
      }),
    );
    return `v1.kms.${Buffer.from(out.CiphertextBlob!).toString('base64')}`;
  }

  async decrypt(ciphertext: string, circleId: string): Promise<string> {
    const [v, kind, blob] = ciphertext.split('.');
    if (v !== 'v1' || kind !== 'kms' || !blob) throw new Error('Unsupported ciphertext');
    const out = await this.client.send(
      new DecryptCommand({ CiphertextBlob: Buffer.from(blob, 'base64'), EncryptionContext: { circleId } }),
    );
    return Buffer.from(out.Plaintext!).toString('utf8');
  }
}
