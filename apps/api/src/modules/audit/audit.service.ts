import { actorOf } from '../../auth/principal.js';
import { currentContext } from '../../context/request-context.js';
import { requireTenantId } from '../../db/scope.js';
import type { TenantDb } from '../../db/tenant-db.js';
import type { ActorType, Prisma } from '../../generated/prisma/client.js';

/**
 * Every audited action, in one place, so names stay consistent and reviewable. The database
 * CHECK constraint (audit_logs_action_format) enforces the dotted shape.
 */
export const AUDIT_ACTIONS = [
  'tenant.provisioned',
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.login.throttled',
  'auth.logout',
  'auth.logout_all',
  'auth.refresh_token.reuse_detected',
  'auth.sso.login.succeeded',
  'auth.sso.login.rejected',
  'auth.sso.user_provisioned',
  'apikey.created',
  'apikey.revoked',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null | undefined;
  metadata?: Prisma.InputJsonObject;
  /** Defaults to the authenticated principal, or "system". */
  actor?: { type: ActorType; id: string | null };
}

/**
 * Writes append-only audit records (the runtime role cannot update or delete them). Records join
 * the caller's transaction when there is one, so an audited change and its audit row commit or
 * roll back together.
 */
export class AuditLogger {
  constructor(private readonly db: TenantDb) {}

  async record(entry: AuditEntry): Promise<void> {
    const context = currentContext();
    const actor = entry.actor
      ? { actorType: entry.actor.type, actorId: entry.actor.id }
      : actorOf(context?.principal);

    await this.db.client.auditLog.create({
      data: {
        tenantId: requireTenantId('Audit logging'),
        ...actor,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        metadata: entry.metadata ?? {},
        ip: context?.ip ?? null,
        userAgent: context?.userAgent?.slice(0, 512) ?? null,
        requestId: context?.requestId ?? null,
      },
    });
  }
}
