import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sortQuerySchema } from '../../lib/keyset.js';
import { pageSchema, paginationQuerySchema } from '../../lib/pagination.js';
import {
  AUDIT_LOG_SORT_FIELDS,
  type AuditLogFilters,
  type AuditLogsService,
  type AuditLogView,
} from './audit-logs.service.js';

export interface AuditLogRoutesOptions {
  auditLogs: AuditLogsService;
}

const actorType = z.enum(['user', 'api_key', 'system']);

const filterFields = {
  action: z
    .string()
    .max(100)
    .regex(
      /^[a-z][a-z0-9_.]*\*?$/,
      'An action such as "course.created", or a prefix such as "auth.*".',
    )
    .optional(),
  actorType: actorType.optional(),
  actorId: z.uuid().optional(),
  resourceType: z.string().max(60).optional(),
  resourceId: z.string().max(100).optional(),
  from: z.iso.datetime().optional().describe('Inclusive.'),
  to: z.iso.datetime().optional().describe('Exclusive.'),
};

type RawFilters = Omit<AuditLogFilters, 'from' | 'to'> & {
  from?: string | undefined;
  to?: string | undefined;
};

const validRange = (query: RawFilters) =>
  !query.from || !query.to || new Date(query.from) < new Date(query.to);
const rangeIssue = { message: 'from must be before to.', path: ['to'] };

function toFilters({ from, to, ...rest }: RawFilters): AuditLogFilters {
  return { ...rest, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined };
}

const auditLogSchema = z.object({
  id: z.uuid(),
  action: z.string(),
  actor: z.object({ type: actorType, id: z.string().nullable() }),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  metadata: z.unknown(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const toAuditLog = (entry: AuditLogView) => ({
  ...entry,
  createdAt: entry.createdAt.toISOString(),
});

export const auditLogRoutes: FastifyPluginAsyncZod<AuditLogRoutesOptions> = async (
  app,
  { auditLogs },
) => {
  const tags = ['audit'];

  app.get(
    '/',
    {
      config: { permissions: ['audit:read'] },
      schema: {
        tags,
        summary: 'Search the audit log (newest first by default)',
        querystring: paginationQuerySchema
          .extend({ sort: sortQuerySchema(AUDIT_LOG_SORT_FIELDS, '-createdAt'), ...filterFields })
          .refine(validRange, rangeIssue),
        response: { 200: pageSchema(auditLogSchema) },
      },
    },
    async (request) => {
      const { limit, cursor, sort, ...filters } = request.query;
      const page = await auditLogs.list({ limit, cursor, sort, ...toFilters(filters) });
      return { data: page.data.map(toAuditLog), pageInfo: page.pageInfo };
    },
  );

  app.get(
    '/export',
    {
      config: { permissions: ['audit:read', 'audit:export'] },
      schema: {
        tags,
        summary: 'Download the audit log as CSV',
        description:
          'Newest first, capped at 50,000 rows; `X-Export-Truncated: true` means older rows were ' +
          'left out, so narrow the range with from/to. Cells that a spreadsheet would evaluate as ' +
          'formulas are neutralised. The export itself is recorded in the audit log.',
        querystring: z.object(filterFields).refine(validRange, rangeIssue),
      },
    },
    async (request, reply) => {
      const { stream, truncated } = await auditLogs.exportCsv(toFilters(request.query));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="audit-log-${stamp}.csv"`)
        .header('cache-control', 'no-store')
        .header('x-export-truncated', String(truncated))
        .send(stream);
    },
  );
};
