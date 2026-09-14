import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * SHA-256, base64url. Appropriate for high-entropy secrets (random tokens), which cannot be
 * brute-forced; passwords use argon2id instead (see lib/password.ts).
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/** Constant-time string comparison (hashing first equalises lengths). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
