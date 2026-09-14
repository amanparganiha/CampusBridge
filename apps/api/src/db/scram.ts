import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/**
 * Builds a PostgreSQL SCRAM-SHA-256 password verifier (the value Postgres itself stores in
 * pg_authid), so role passwords can be set without the plaintext ever reaching the server,
 * where it could otherwise land in logs or pg_stat_statements.
 *
 * Format: SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey> (RFC 5802 / RFC 7677).
 * Postgres applies SASLprep to passwords; for printable ASCII that is the identity, so other
 * characters are rejected rather than risk a verifier that silently never matches.
 */
export function scramSha256Verifier(
  password: string,
  { salt = randomBytes(16), iterations = 4096 }: { salt?: Buffer; iterations?: number } = {},
): string {
  if (!PRINTABLE_ASCII.test(password)) {
    throw new Error('Database passwords must be non-empty printable ASCII');
  }

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();

  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
