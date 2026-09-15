import { requireTenantId } from '../../db/scope.js';
import type { TenantDb } from '../../db/tenant-db.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Domain events that leave the service (outgoing webhooks, emails, analytics). The catalog is the
 * public contract for webhook consumers, so names are stable and dotted: `<aggregate>.<event>`.
 */
export const OUTBOX_EVENTS = [
  'user.invited',
  'user.status_changed',
  'user.roles_changed',
  'course.created',
  'course.updated',
  'course.published',
  'course.archived',
  'course.deleted',
  'enrollment.created',
  'enrollment.status_changed',
  'grade.recorded',
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENTS)[number];

export interface OutboxEntry {
  type: OutboxEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Prisma.InputJsonObject;
}

/**
 * Transactional outbox. Events are rows written through the ambient transaction, so they commit
 * exactly when the change they describe commits, and vanish with it on rollback: no "email sent
 * for an enrollment that never happened", no lost webhook. The worker's relay publishes them
 * asynchronously (at-least-once; consumers dedupe on the event id).
 */
export class Outbox {
  constructor(private readonly db: TenantDb) {}

  async emit(entry: OutboxEntry): Promise<void> {
    await this.db.client.outboxEvent.create({
      data: {
        tenantId: requireTenantId('Emitting a domain event'),
        type: entry.type,
        aggregateType: entry.aggregateType,
        aggregateId: entry.aggregateId,
        payload: entry.payload,
      },
    });
  }
}
