import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * SHA-256, base64url. Appropriate for high-entropy secrets (random tokens), which cannot be
 * brute-forced; passwords use argon2id instead (see lib/password.ts).
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/**
 * Deterministic JSON: object keys sorted recursively, so logically equal bodies hash equally no
 * matter how a client ordered their fields.
 */
export function canonicalJson(value: unknown): string {
  const normalise = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalise);
    if (item !== null && typeof item === 'object' && !(item instanceof Date)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, nested]) => [key, normalise(nested)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalise(value ?? null));
}

/** Constant-time string comparison (hashing first equalises lengths). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
