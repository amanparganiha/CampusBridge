import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id with OWASP's baseline parameters (19 MiB memory, 2 iterations, 1 lane). Parameters
 * are embedded in each hash, so they can be raised later and old hashes keep verifying; a login
 * can rehash when `needsRehash` says the stored parameters are outdated.
 */
const PARAMETERS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const CURRENT_PREFIX = `$argon2id$v=19$m=${String(PARAMETERS.memoryCost)},t=${String(PARAMETERS.timeCost)},p=${String(PARAMETERS.parallelism)}$`;

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMETERS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // A malformed stored hash is a failed verification, never an exception at login.
    return false;
  }
}

export function needsRehash(passwordHash: string): boolean {
  return !passwordHash.startsWith(CURRENT_PREFIX);
}
