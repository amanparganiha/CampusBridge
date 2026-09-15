import type { PermissionResolver } from '../../auth/permission-resolver.js';
import type { Principal } from '../../auth/principal.js';
import type { TenantDb } from '../../db/tenant-db.js';
import { ForbiddenError, UnprocessableError } from '../../lib/errors.js';

/**
 * Guards role assignment (invitations, role changes) against privilege escalation: a principal
 * may only grant or remove roles whose permissions it holds itself. Otherwise anyone with
 * `role:assign` could make themselves (or an accomplice) an administrator.
 */
export async function assertCanGrantRoles(
  deps: { db: TenantDb; permissions: PermissionResolver },
  principal: Principal,
  roleKeys: readonly string[],
): Promise<void> {
  if (roleKeys.length === 0) return;
  const known = await deps.db.client.role.findMany({
    where: { key: { in: [...roleKeys] } },
    select: { key: true },
  });
  const unknown = roleKeys.filter((key) => !known.some((role) => role.key === key));
  if (unknown.length > 0) {
    throw new UnprocessableError(`Unknown role: ${unknown.join(', ')}.`, { code: 'UNKNOWN_ROLE' });
  }

  const granted = await deps.permissions.forRoles(roleKeys);
  const beyond = [...granted].filter((permission) => !principal.permissions.has(permission));
  if (beyond.length > 0) {
    throw new ForbiddenError(
      `You cannot grant a role with permissions you do not hold (${beyond.slice(0, 5).join(', ')}).`,
      { code: 'ROLE_NOT_GRANTABLE' },
    );
  }
}
