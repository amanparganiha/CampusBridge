import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Envelope for secrets stored in the database (SSO client secrets, integration credentials).
 *
 * AES-256-GCM with a random 96-bit IV, authenticated with additional data (AAD) naming what the
 * ciphertext belongs to, e.g. `integration:<tenantId>:oidc`. A ciphertext copied into another
 * row or another tenant therefore fails to decrypt instead of being silently accepted.
 *
 * Format: `enc1.<keyId>.<iv>.<ciphertext>.<tag>` (base64url parts). The key id makes rotation
 * possible: encrypt with the active key, decrypt with whichever key the payload names.
 */

export const encryptionKeysSchema = z.object({
  active: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  keys: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), z.string()),
});
export type EncryptionKeys = z.infer<typeof encryptionKeysSchema>;

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`Cannot decrypt secret: ${reason}`);
    this.name = 'DecryptionError';
  }
}

const FORMAT = 'enc1';

export class Encryptor {
  readonly #keys: Map<string, Buffer>;
  readonly #activeKeyId: string;

  constructor(config: EncryptionKeys) {
    this.#keys = new Map(
      Object.entries(config.keys).map(([id, encoded]) => {
        const key = Buffer.from(encoded, 'base64');
        if (key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes (base64)`);
        return [id, key];
      }),
    );
    if (!this.#keys.has(config.active)) {
      throw new Error(`Active encryption key "${config.active}" is not in the key list`);
    }
    this.#activeKeyId = config.active;
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key(this.#activeKeyId), iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [FORMAT, this.#activeKeyId, iv, ciphertext, cipher.getAuthTag()]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  decrypt(payload: string, aad: string): string {
    const [format, keyId, iv, ciphertext, tag, ...rest] = payload.split('.');
    if (format !== FORMAT || !keyId || !iv || !ciphertext || !tag || rest.length > 0) {
      throw new DecryptionError('unrecognised format');
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#key(keyId),
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      if (error instanceof DecryptionError) throw error;
      throw new DecryptionError('authentication failed (wrong key, context or tampered data)');
    }
  }

  encryptJson(value: unknown, aad: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(payload: string, aad: string, schema: z.ZodType<T>): T {
    return schema.parse(JSON.parse(this.decrypt(payload, aad)));
  }

  #key(id: string): Buffer {
    const key = this.#keys.get(id);
    if (!key) throw new DecryptionError(`unknown key "${id}"`);
    return key;
  }
}
