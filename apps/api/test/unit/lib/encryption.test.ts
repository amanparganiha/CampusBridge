import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DecryptionError, Encryptor } from '../../../src/lib/crypto/encryption.js';

const key = () => randomBytes(32).toString('base64');

describe('Encryptor', () => {
  const encryptor = new Encryptor({ active: 'k1', keys: { k1: key() } });

  it('round-trips a secret and never produces the same ciphertext twice', () => {
    const first = encryptor.encrypt('client-secret', 'integration:t1:oidc');
    const second = encryptor.encrypt('client-secret', 'integration:t1:oidc');

    expect(first).toMatch(/^enc1\.k1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(first).not.toBe(second);
    expect(encryptor.decrypt(first, 'integration:t1:oidc')).toBe('client-secret');
  });

  it('refuses a ciphertext moved to another row or tenant (AAD mismatch)', () => {
    const sealed = encryptor.encrypt('client-secret', 'integration:tenant-a:oidc');

    expect(() => encryptor.decrypt(sealed, 'integration:tenant-b:oidc')).toThrow(DecryptionError);
  });

  it('detects tampering', () => {
    const [format, keyId, iv, ciphertext, tag] = encryptor
      .encrypt('client-secret', 'ctx')
      .split('.');
    const flipped = Buffer.from(ciphertext!, 'base64url');
    flipped[0]! ^= 0xff;

    expect(() =>
      encryptor.decrypt([format, keyId, iv, flipped.toString('base64url'), tag].join('.'), 'ctx'),
    ).toThrow(DecryptionError);
  });

  it('decrypts with retired keys after rotation, while encrypting with the new one', () => {
    const oldKey = key();
    const before = new Encryptor({ active: 'old', keys: { old: oldKey } });
    const sealed = before.encrypt('secret', 'ctx');

    const after = new Encryptor({ active: 'new', keys: { new: key(), old: oldKey } });

    expect(after.decrypt(sealed, 'ctx')).toBe('secret');
    expect(after.encrypt('secret', 'ctx')).toMatch(/^enc1\.new\./);
  });

  it('validates JSON payloads on the way out', () => {
    const sealed = encryptor.encryptJson({ clientSecret: 'abc' }, 'ctx');

    expect(encryptor.decryptJson(sealed, 'ctx', z.object({ clientSecret: z.string() }))).toEqual({
      clientSecret: 'abc',
    });
  });

  it('rejects misconfigured keys at startup', () => {
    expect(
      () => new Encryptor({ active: 'k1', keys: { k1: randomBytes(16).toString('base64') } }),
    ).toThrow(/32 bytes/);
    expect(() => new Encryptor({ active: 'missing', keys: { k1: key() } })).toThrow(
      /not in the key list/,
    );
  });
});
