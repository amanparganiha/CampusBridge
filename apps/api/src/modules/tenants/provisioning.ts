import { z } from 'zod';
import { SYSTEM_ROLES, type SystemRoleKey } from '../../authz/permissions.js';
// The one sanctioned exception to "feature code uses TenantDb": provisioning creates a tenant,
// so no tenant context can exist yet. It runs with the schema owner's client (operator CLI).
// eslint-disable-next-line no-restricted-imports
import type { Prisma, PrismaClient, Tenant, User } from '../../generated/prisma/client.js';
import { hashPassword } from '../../lib/password.js';

/** Mirrors the tenants_slug_format CHECK constraint. */
export const tenantSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/, 'Use 2-63 lowercase letters, digits or hyphens.');

export const provisionTenantInputSchema = z.object({
  slug: tenantSlugSchema,
  name: z.string().trim().min(1).max(200),
  admin: z.object({
    email: z.email().transform((email) => email.toLowerCase()),
    name: z.string().trim().min(1).max(200),
    /** Omit to create the admin as `invited` (they set a password via the invite flow). */
    password: z.string().min(12).max(256).optional(),
  }),
  settings: z
    .custom<Prisma.InputJsonObject>((value) => typeof value === 'object' && value !== null)
    .optional(),
});

export type ProvisionTenantInput = z.input<typeof provisionTenantInputSchema>;

export interface ProvisionedTenant {
  tenant: Tenant;
  admin: User;
  roleIds: Record<SystemRoleKey, string>;
}

/**
 * Creates a school with its system roles and first administrator in one transaction.
 *
 * Runs with the schema owner's connection. Provisioning is an operator action by design: no API
 * role can create tenants or see any tenant but its own.
 */
export async function provisionTenant(
  ownerDb: PrismaClient,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  const { slug, name, admin, settings } = provisionTenantInputSchema.parse(input);
  const passwordHash = admin.password ? await hashPassword(admin.password) : null;

  return ownerDb.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: { slug, name, settings: settings ?? {} } });

    const roleIds: Partial<Record<SystemRoleKey, string>> = {};
    for (const [key, definition] of Object.entries(SYSTEM_ROLES) as [
      SystemRoleKey,
      (typeof SYSTEM_ROLES)[SystemRoleKey],
    ][]) {
      const role = await tx.role.create({
        data: {
          tenantId: tenant.id,
          key,
          name: definition.name,
          description: definition.description,
          isSystem: true,
        },
      });
      await tx.rolePermission.createMany({
        data: definition.permissions.map((permissionKey) => ({
          tenantId: tenant.id,
          roleId: role.id,
          permissionKey,
        })),
      });
      roleIds[key] = role.id;
    }
    const allRoleIds = roleIds as Record<SystemRoleKey, string>;

    const adminUser = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: admin.email,
        name: admin.name,
        passwordHash,
        status: passwordHash ? 'active' : 'invited',
      },
    });
    await tx.userRole.create({
      data: { tenantId: tenant.id, userId: adminUser.id, roleId: allRoleIds.admin },
    });
    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorType: 'system',
        action: 'tenant.provisioned',
        resourceType: 'tenant',
        resourceId: tenant.id,
        metadata: { slug, adminUserId: adminUser.id },
      },
    });

    return { tenant, admin: adminUser, roleIds: allRoleIds };
  });
}
