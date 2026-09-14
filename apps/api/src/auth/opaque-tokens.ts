import { randomBytes } from 'node:crypto';
import { sha256 } from '../lib/crypto/hash.js';

/**
 * Opaque bearer secrets (refresh tokens, API keys, invitations, password resets).
 *
 *   <kind>_<tenantId>_<secret>     e.g.  rt_01a09e9a-4173-77ad-97f4-aa5db3ef9ff7_Q2x...
 *
 * - The tenant id makes the token *routable*: the server sets the tenant context from it before
 *   touching the database, so looking a token up never needs cross-tenant access. Tampering with
 *   the tenant part only makes the lookup miss.
 * - The secret is 256 random bits; only its SHA-256 hash is stored.
 * - The kind prefix lets secret scanners (e.g. GitHub push protection) recognise leaked keys.
 */

export type OpaqueTokenKind = 'rt' | 'cbk' | 'inv' | 'pwr';

const TOKEN_PATTERN =
  /^(rt|cbk|inv|pwr)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export interface IssuedOpaqueToken {
  /** Returned to the client exactly once. */
  token: string;
  /** What gets stored. */
  hash: string;
  /** Short, non-secret fragment for display ("cbk_…Q2xh"). */
  hint: string;
}

export interface ParsedOpaqueToken {
  tenantId: string;
  hash: string;
}

export function issueOpaqueToken(kind: OpaqueTokenKind, tenantId: string): IssuedOpaqueToken {
  const secret = randomBytes(32).toString('base64url');
  const token = `${kind}_${tenantId.toLowerCase()}_${secret}`;
  return { token, hash: sha256(token), hint: secret.slice(-4) };
}

/** Returns null for anything that is not a well-formed token of the expected kind. */
export function parseOpaqueToken(token: string, kind: OpaqueTokenKind): ParsedOpaqueToken | null {
  const match = TOKEN_PATTERN.exec(token);
  if (match?.[1] !== kind || !match[2]) return null;
  return { tenantId: match[2], hash: sha256(token) };
}
