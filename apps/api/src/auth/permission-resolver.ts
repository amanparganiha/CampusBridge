import { PERMISSIONS, type Permission } from '../authz/permissions.js';
import { requireTenantId } from '../db/scope.js';
import type { TenantDb } from '../db/tenant-db.js';

interface CacheEntry {
  permissions: ReadonlySet<Permission>;
  expiresAt: number;
}

const MAX_ENTRIES = 5_000;

function isPermission(key: string): key is Permission {
  return Object.hasOwn(PERMISSIONS, key);
}

/**
 * Resolves role keys to permissions (RBAC). Role definitions live in the database so schools
 * can have custom roles; the result is cached briefly per tenant + role set because it is needed
 * on every authenticated request. A role edit therefore takes effect within `ttlMs`.
 */
export class PermissionResolver {
  readonly #cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: TenantDb,
    private readonly ttlMs = 60_000,
  ) {}

  /** The user's role keys (for tokens) and the permissions they grant. */
  async forUser(
    userId: string,
  ): Promise<{ roles: string[]; permissions: ReadonlySet<Permission> }> {
    const grants = await this.db.client.userRole.findMany({
      where: { userId },
      select: { role: { select: { key: true } } },
    });
    const roles = grants.map((grant) => grant.role.key).sort();
    return { roles, permissions: await this.forRoles(roles) };
  }

  async forRoles(roleKeys: readonly string[]): Promise<ReadonlySet<Permission>> {
    const tenantId = requireTenantId('Permission resolution');
    const cacheKey = `${tenantId}:${[...roleKeys].sort().join(',')}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.permissions;

    const grants = roleKeys.length
      ? await this.db.client.rolePermission.findMany({
          where: { role: { key: { in: [...roleKeys] } } },
          select: { permissionKey: true },
        })
      : [];
    const permissions: ReadonlySet<Permission> = new Set(
      grants.map((grant) => grant.permissionKey).filter(isPermission),
    );

    if (this.#cache.size >= MAX_ENTRIES) this.#cache.clear();
    this.#cache.set(cacheKey, { permissions, expiresAt: Date.now() + this.ttlMs });
    return permissions;
  }

  /** Call after changing a tenant's role definitions (this process only; others expire). */
  invalidateTenant(tenantId: string): void {
    for (const key of this.#cache.keys())
      if (key.startsWith(`${tenantId}:`)) this.#cache.delete(key);
  }
}
