import type { Permission } from '../authz/permissions.js';

/** Who is making the request, resolved once by the authentication hook. */
export type Principal = UserPrincipal | ApiKeyPrincipal;

export interface UserPrincipal {
  readonly kind: 'user';
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
}

/**
 * A partner system calling with an API key. It acts as a tenant-level service account limited
 * to the key's scopes: ownership rules (e.g. "an instructor's own courses") do not apply to it.
 */
export interface ApiKeyPrincipal {
  readonly kind: 'api_key';
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly permissions: ReadonlySet<Permission>;
}

export function hasPermission(principal: Principal | undefined, permission: Permission): boolean {
  return principal?.permissions.has(permission) ?? false;
}

/** How a principal is recorded in audit logs. */
export function actorOf(principal: Principal | undefined): {
  actorType: 'user' | 'api_key' | 'system';
  actorId: string | null;
} {
  if (!principal) return { actorType: 'system', actorId: null };
  return principal.kind === 'user'
    ? { actorType: 'user', actorId: principal.userId }
    : { actorType: 'api_key', actorId: principal.apiKeyId };
}
