import { Readable } from 'node:stream';
import {
  currentContext,
  runWithContext,
  type RequestContext,
} from '../../context/request-context.js';
import type { TenantDb } from '../../db/tenant-db.js';
import type { ActorType, AuditLog, Prisma } from '../../generated/prisma/client.js';
import { csvRow } from '../../lib/csv.js';
import { keysetArgs, keysetPage, type SortOption } from '../../lib/keyset.js';
import type { Page } from '../../lib/pagination.js';
import type { AuditLogger } from './audit.service.js';

export const AUDIT_LOG_SORT_FIELDS = ['createdAt'] as const;

export interface AuditLogFilters {
  /** An exact action, or a prefix ending in `*`: `auth.*` matches every sign-in event. */
  action?: string | undefined;
  actorType?: ActorType | undefined;
  actorId?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export interface AuditLogListQuery extends AuditLogFilters {
  limit: number;
  cursor?: string | undefined;
  sort: SortOption<(typeof AUDIT_LOG_SORT_FIELDS)[number]>;
}

export interface AuditLogView {
  id: string;
  action: string;
  actor: { type: ActorType; id: string | null };
  resourceType: string;
  resourceId: string | null;
  metadata: Prisma.JsonValue;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: Date;
}

export interface CsvExport {
  stream: Readable;
  /** More rows matched than the export limit; the oldest were left out. */
  truncated: boolean;
}

const toView = (row: AuditLog): AuditLogView => ({
  id: row.id,
  action: row.action,
  actor: { type: row.actorType, id: row.actorId },
  resourceType: row.resourceType,
  resourceId: row.resourceId,
  metadata: row.metadata,
  ip: row.ip,
  userAgent: row.userAgent,
  requestId: row.requestId,
  createdAt: row.createdAt,
});

function filtersWhere(filters: AuditLogFilters): Prisma.AuditLogWhereInput {
  const { action } = filters;
  return {
    ...(action
      ? { action: action.endsWith('*') ? { startsWith: action.slice(0, -1) } : action }
      : {}),
    ...(filters.actorType ? { actorType: filters.actorType } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
    ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lt: filters.to } : {}),
          },
        }
      : {}),
  };
}

const CSV_HEADER = [
  'created_at',
  'action',
  'actor_type',
  'actor_id',
  'resource_type',
  'resource_id',
  'ip',
  'user_agent',
  'request_id',
  'metadata',
];

const EXPORT_BATCH_SIZE = 1_000;

/** Reads (and exports) the append-only audit trail of the current school. */
export class AuditLogsService {
  readonly #maxExportRows: number;

  constructor(private readonly deps: { db: TenantDb; audit: AuditLogger; maxExportRows?: number }) {
    this.#maxExportRows = deps.maxExportRows ?? 50_000;
  }

  async list(query: AuditLogListQuery): Promise<Page<AuditLogView>> {
    const keyset = keysetArgs(query.sort, query.cursor, (_field, value) => new Date(String(value)));
    const rows = await this.deps.db.client.auditLog.findMany({
      where: { AND: [filtersWhere(query), keyset.where as Prisma.AuditLogWhereInput] },
      orderBy: keyset.orderBy as Prisma.AuditLogOrderByWithRelationInput[],
      take: query.limit + 1,
    });
    return keysetPage(rows, query.limit, query.sort, (row) => row.createdAt.toISOString(), toView);
  }

  /**
   * Newest first, up to the export limit, streamed in batches so a large export never sits in
   * memory. The export is itself audited before the first byte is sent: who pulled which slice of
   * the trail is part of the trail.
   */
  async exportCsv(filters: AuditLogFilters): Promise<CsvExport> {
    const where = filtersWhere(filters);
    const orderBy: Prisma.AuditLogOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];
    const overflow = await this.deps.db.client.auditLog.findFirst({
      where,
      orderBy,
      skip: this.#maxExportRows,
      select: { id: true },
    });
    const truncated = overflow !== null;

    await this.deps.audit.record({
      action: 'data.exported',
      resourceType: 'audit_log',
      metadata: {
        format: 'csv',
        truncated,
        filters: JSON.parse(JSON.stringify(filters)) as Prisma.InputJsonObject,
      },
    });

    // Batches are read as the client consumes the stream, after this request's async context has
    // moved on, so each read re-enters the captured context explicitly (tenant binding included).
    const captured = currentContext();
    if (!captured) throw new Error('Audit export requires a request context.');
    const context: RequestContext = captured;
    const db = this.deps.db;
    const limit = this.#maxExportRows;

    async function* rows(): AsyncGenerator<string> {
      yield csvRow(CSV_HEADER);
      let sent = 0;
      let after: { createdAt: Date; id: string } | undefined;
      while (sent < limit) {
        const cursor = after;
        const batch = await runWithContext(
          context,
          async () =>
            await db.client.auditLog.findMany({
              where: {
                AND: [
                  where,
                  cursor
                    ? {
                        OR: [
                          { createdAt: { lt: cursor.createdAt } },
                          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                        ],
                      }
                    : {},
                ],
              },
              orderBy,
              take: Math.min(EXPORT_BATCH_SIZE, limit - sent),
            }),
        );
        for (const row of batch) {
          yield csvRow([
            row.createdAt,
            row.action,
            row.actorType,
            row.actorId,
            row.resourceType,
            row.resourceId,
            row.ip,
            row.userAgent,
            row.requestId,
            row.metadata,
          ]);
        }
        sent += batch.length;
        const last = batch.at(-1);
        if (!last || batch.length < EXPORT_BATCH_SIZE) return;
        after = { createdAt: last.createdAt, id: last.id };
      }
    }

    return { stream: Readable.from(rows(), { objectMode: false }), truncated };
  }
}
