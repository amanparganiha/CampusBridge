import { describe, expect, it } from 'vitest';
import { scramSha256Verifier } from '../../../src/db/scram.js';

// Captured from PostgreSQL 17: CREATE ROLE ... PASSWORD 'correct horse battery staple',
// then SELECT rolpassword FROM pg_authid. Matching it byte-for-byte proves compatibility.
const POSTGRES_VECTOR = {
  password: 'correct horse battery staple',
  verifier:
    'SCRAM-SHA-256$4096:MpKFhZX+nYuTN1W5te5o5Q==$gLF8fNEWQ9MGjP4MgVjMt/wU6jX8vJuB+gVi5PkF/os=:cQe47UegyVZRZzel+qpeAGNXd3xTQqslPtiRFhKkYYw=',
  salt: Buffer.from('MpKFhZX+nYuTN1W5te5o5Q==', 'base64'),
};

describe('scramSha256Verifier', () => {
  it('reproduces the verifier PostgreSQL computes for the same password and salt', () => {
    expect(scramSha256Verifier(POSTGRES_VECTOR.password, { salt: POSTGRES_VECTOR.salt })).toBe(
      POSTGRES_VECTOR.verifier,
    );
  });

  it('uses a fresh random salt for each call', () => {
    const first = scramSha256Verifier('same-password');
    const second = scramSha256Verifier('same-password');

    expect(first).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(first).not.toBe(second);
  });

  it.each(['', 'pässword', 'tab\tseparated'])(
    'rejects password %j that SASLprep could alter',
    (password) => {
      expect(() => scramSha256Verifier(password)).toThrow(/printable ASCII/);
    },
  );
});
