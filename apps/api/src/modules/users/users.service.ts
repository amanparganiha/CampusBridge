import type { PermissionResolver } from '../../auth/permission-resolver.js';
import type { Principal } from '../../auth/principal.js';
import { requireTenantId } from '../../db/scope.js';
import type { TenantDb } from '../../db/tenant-db.js';
import type { Prisma, UserStatus } from '../../generated/prisma/client.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { keysetArgs, keysetPage, type SortOption } from '../../lib/keyset.js';
import type { Page } from '../../lib/pagination.js';
import type { AuditLogger } from '../audit/audit.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { Outbox } from '../outbox/outbox.service.js';
import { assertCanGrantRoles } from './role-grants.js';

export interface UserView {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  roles: string[];
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

export const USER_SORT_FIELDS = ['name', 'email', 'createdAt'] as const;

export interface UserListQuery {
  limit: number;
  cursor?: string | undefined;
  sort: SortOption<(typeof USER_SORT_FIELDS)[number]>;
  role?: string | undefined;
  status?: UserStatus | undefined;
  q?: string | undefined;
}

const withRoles = { userRoles: { select: { role: { select: { key: true } } } } } as const;
type UserRow = Prisma.UserGetPayload<{ include: typeof withRoles }>;

const toView = (user: UserRow): UserView => ({
  id: user.id,
  email: user.email,
  name: user.name,
  status: user.status,
  roles: user.userRoles.map((grant) => grant.role.key).sort(),
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
});

const userNotFound = () => new NotFoundError('User not found.');

export class UsersService {
  constructor(
    private readonly deps: {
      db: TenantDb;
      audit: AuditLogger;
      outbox: Outbox;
      auth: AuthService;
      permissions: PermissionResolver;
    },
  ) {}

  async list(query: UserListQuery): Promise<Page<UserView>> {
    const keyset = keysetArgs(query.sort, query.cursor, (field, value) =>
      field === 'createdAt' ? new Date(String(value)) : value,
    );
    const filters: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { userRoles: { some: { role: { key: query.role } } } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const rows = await this.deps.db.client.user.findMany({
      where: { AND: [filters, keyset.where as Prisma.UserWhereInput] },
      orderBy: keyset.orderBy as Prisma.UserOrderByWithRelationInput[],
      take: query.limit + 1,
      include: withRoles,
    });
    return keysetPage(
      rows,
      query.limit,
      query.sort,
      (row) =>
        query.sort.field === 'createdAt' ? row.createdAt.toISOString() : row[query.sort.field],
      toView,
    );
  }

  async get(id: string): Promise<UserView> {
    const user = await this.deps.db.client.user.findUnique({ where: { id }, include: withRoles });
    if (!user) throw userNotFound();
    return toView(user);
  }

  async listRoles(): Promise<RoleView[]> {
    const roles = await this.deps.db.client.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { key: 'asc' }],
      include: { rolePermissions: { select: { permissionKey: true } } },
    });
    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions: role.rolePermissions.map((grant) => grant.permissionKey).sort(),
    }));
  }

  /** Rename, suspend or reactivate. Suspension ends every session of the user immediately. */
  async update(
    principal: Principal,
    id: string,
    input: { name?: string | undefined; status?: 'active' | 'suspended' | undefined },
  ): Promise<UserView> {
    const result = await this.deps.db.transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id }, include: withRoles });
      if (!user) throw userNotFound();

      const statusChange = input.status && input.status !== user.status ? input.status : undefined;
      if (statusChange === 'suspended') {
        if (principal.kind === 'user' && principal.userId === id) {
          throw new UnprocessableError('You cannot suspend your own account.', {
            code: 'CANNOT_SUSPEND_SELF',
          });
        }
        await this.#assertNotLastAdmin(id, 'suspend');
      }
      if (statusChange === 'active' && user.status === 'invited') {
        throw new UnprocessableError('Invited users become active by accepting their invitation.', {
          code: 'INVITATION_PENDING',
        });
      }

      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(statusChange ? { status: statusChange } : {}),
        },
        include: withRoles,
      });

      if (statusChange) {
        await this.deps.audit.record({
          action: statusChange === 'suspended' ? 'user.suspended' : 'user.reactivated',
          resourceType: 'user',
          resourceId: id,
          metadata: { from: user.status, to: statusChange },
        });
        await this.deps.outbox.emit({
          type: 'user.status_changed',
          aggregateType: 'user',
          aggregateId: id,
          payload: { userId: id, from: user.status, to: statusChange },
        });
      }
      if (input.name !== undefined && input.name !== user.name) {
        await this.deps.audit.record({
          action: 'user.updated',
          resourceType: 'user',
          resourceId: id,
          metadata: { changed: ['name'] },
        });
      }
      return { view: toView(updated), suspended: statusChange === 'suspended' };
    });

    if (result.suspended) await this.#endSessions(id, 'user_suspended');
    return result.view;
  }

  /** Replaces the user's roles. Removing a role ends their sessions so it takes effect at once. */
  async setRoles(principal: Principal, id: string, roleKeys: readonly string[]): Promise<UserView> {
    const next = [...new Set(roleKeys)].sort();
    const result = await this.deps.db.transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id }, include: withRoles });
      if (!user) throw userNotFound();
      const current = user.userRoles.map((grant) => grant.role.key).sort();
      const added = next.filter((key) => !current.includes(key));
      const removed = current.filter((key) => !next.includes(key));
      if (added.length === 0 && removed.length === 0) return { view: toView(user), removed };

      // Granting and revoking are symmetric: you may only touch roles you could grant.
      await assertCanGrantRoles(this.deps, principal, [...added, ...removed]);
      if (removed.includes('admin')) await this.#assertNotLastAdmin(id, 'demote');

      const roles = await tx.role.findMany({ where: { key: { in: [...added, ...removed] } } });
      const roleIds = new Map(roles.map((role) => [role.key, role.id]));
      const idOf = (key: string) => {
        const roleId = roleIds.get(key);
        if (!roleId)
          throw new UnprocessableError(`Unknown role: ${key}.`, { code: 'UNKNOWN_ROLE' });
        return roleId;
      };
      if (removed.length > 0) {
        await tx.userRole.deleteMany({ where: { userId: id, roleId: { in: removed.map(idOf) } } });
      }
      for (const key of added) {
        await tx.userRole.create({
          data: {
            tenantId: user.tenantId,
            userId: id,
            roleId: idOf(key),
            grantedById: principal.kind === 'user' ? principal.userId : null,
          },
        });
      }

      await this.deps.audit.record({
        action: 'user.roles_changed',
        resourceType: 'user',
        resourceId: id,
        metadata: { before: current, after: next },
      });
      await this.deps.outbox.emit({
        type: 'user.roles_changed',
        aggregateType: 'user',
        aggregateId: id,
        payload: { userId: id, before: current, after: next },
      });
      const updated = await tx.user.findUniqueOrThrow({ where: { id }, include: withRoles });
      return { view: toView(updated), removed };
    });

    if (result.removed.length > 0) await this.#endSessions(id, 'roles_reduced');
    return result.view;
  }

  /**
   * A school must always keep at least one active administrator. Runs inside the caller's
   * transaction and first takes a per-school advisory lock: without it, two admins demoting each
   * other concurrently would each see the other and both succeed, leaving none.
   */
  async #assertNotLastAdmin(userId: string, action: 'suspend' | 'demote'): Promise<void> {
    const lockKey = `admins:${requireTenantId()}`;
    await this.deps.db.client
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const otherAdmins = await this.deps.db.client.user.count({
      where: {
        id: { not: userId },
        status: 'active',
        userRoles: { some: { role: { key: 'admin' } } },
      },
    });
    const isAdmin = await this.deps.db.client.userRole.count({
      where: { userId, role: { key: 'admin' } },
    });
    if (isAdmin > 0 && otherAdmins === 0) {
      throw new ConflictError(`You cannot ${action} the last active administrator.`, {
        code: 'LAST_ADMIN',
      });
    }
  }

  async #endSessions(userId: string, reason: string): Promise<void> {
    const sessions = await this.deps.db.client.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    await this.deps.auth.revokeSessions(
      sessions.map((session) => session.id),
      reason,
    );
  }
}
