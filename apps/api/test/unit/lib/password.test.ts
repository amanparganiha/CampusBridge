import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword } from '../../../src/lib/password.js';

describe('password hashing', () => {
  it('produces argon2id hashes with the configured parameters and a unique salt', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(second);
    expect(needsRehash(first)).toBe(false);
  });

  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it('treats a corrupted stored hash as a failed login, not an exception', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('flags hashes made with older parameters for rehashing', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$c2FsdHNhbHQ$aGFzaA')).toBe(true);
  });
});
