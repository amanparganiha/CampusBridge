import { Prisma } from '../generated/prisma/client.js';
import { currentTenantId, currentTransaction, MissingTenantContextError } from './scope.js';
import { TENANT_SCOPED_MODELS } from './tenant-models.js';

/**
 * Application-level tenant isolation (layer 2 of 3; see docs/multi-tenancy.md).
 *
 * 1. Every operation on a tenant-owned model gets the current tenant injected into its filter
 *    (reads, updates, deletes) or its data (creates). Tenant ids that disagree with the context
 *    are rejected rather than silently overridden, and a missing context fails closed.
 * 2. Every operation in a tenant context is bound to that tenant at the connection level
 *    (`SET LOCAL app.tenant_id`), which is what the row-level security policies (layer 3) check.
 *    Outside an explicit transaction that means wrapping the statement in a short batch
 *    transaction: a few extra round trips, traded for connection-pool compatibility (the setting
 *    is transaction-local, so it never leaks to the next borrower of the connection).
 */

export class CrossTenantAccessError extends Error {
  constructor(model: string, operation: string, detail: string) {
    super(`${model}.${operation}: ${detail}`);
    this.name = 'CrossTenantAccessError';
  }
}

type Args = Record<string, unknown>;

const FILTERED_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'delete',
  'deleteMany',
]);
const UPDATE_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn']);
const CREATE_MANY_OPERATIONS = new Set(['createMany', 'createManyAndReturn']);

function asArgs(value: unknown): Args {
  return value !== null && typeof value === 'object' ? (value as Args) : {};
}

/** Adds the tenant to a filter; a filter naming any other tenant (or a tenant range) is refused. */
function scopeWhere(where: unknown, tenantId: string, model: string, operation: string): Args {
  const filter = asArgs(where);
  if ('tenantId' in filter && filter.tenantId !== tenantId) {
    throw new CrossTenantAccessError(model, operation, 'filter targets a different tenant');
  }
  // Compound unique inputs such as { tenantId_email: { tenantId, email } }.
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('tenantId_') && asArgs(value).tenantId !== tenantId) {
      throw new CrossTenantAccessError(model, operation, `${key} targets a different tenant`);
    }
  }
  return { ...filter, tenantId };
}

/** Stamps the tenant onto new rows. */
function scopeCreateData(data: unknown, tenantId: string, model: string, operation: string): Args {
  const row = asArgs(data);
  if ('tenant' in row) {
    throw new CrossTenantAccessError(
      model,
      operation,
      'set tenantId implicitly; do not connect the tenant relation',
    );
  }
  if ('tenantId' in row && row.tenantId !== tenantId) {
    throw new CrossTenantAccessError(model, operation, 'data targets a different tenant');
  }
  return { ...row, tenantId };
}

/** Rows never move between tenants. */
function assertTenantUnchanged(
  data: unknown,
  tenantId: string,
  model: string,
  operation: string,
): void {
  const changes = asArgs(data);
  if ('tenant' in changes || ('tenantId' in changes && changes.tenantId !== tenantId)) {
    throw new CrossTenantAccessError(model, operation, 'tenantId cannot be changed');
  }
}

/** Pure function: returns operation arguments scoped to `tenantId`, or throws. */
export function scopeArgs(model: string, operation: string, args: unknown, tenantId: string): Args {
  const scoped = { ...asArgs(args) };

  if (FILTERED_OPERATIONS.has(operation)) {
    scoped.where = scopeWhere(scoped.where, tenantId, model, operation);
  } else if (UPDATE_OPERATIONS.has(operation)) {
    assertTenantUnchanged(scoped.data, tenantId, model, operation);
    scoped.where = scopeWhere(scoped.where, tenantId, model, operation);
  } else if (operation === 'create') {
    scoped.data = scopeCreateData(scoped.data, tenantId, model, operation);
  } else if (CREATE_MANY_OPERATIONS.has(operation)) {
    const rows: unknown[] = Array.isArray(scoped.data) ? scoped.data : [scoped.data];
    scoped.data = rows.map((row) => scopeCreateData(row, tenantId, model, operation));
  } else if (operation === 'upsert') {
    scoped.where = scopeWhere(scoped.where, tenantId, model, operation);
    scoped.create = scopeCreateData(scoped.create, tenantId, model, operation);
    assertTenantUnchanged(scoped.update, tenantId, model, operation);
  } else {
    // Fail closed: an operation this code does not understand must not run unscoped.
    throw new CrossTenantAccessError(
      model,
      operation,
      'operation is not supported on tenant-owned models',
    );
  }

  return scoped;
}

export function tenantIsolation() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'tenant-isolation',
      query: {
        async $allOperations({ model, operation, args, query }): Promise<unknown> {
          // Prisma types these generically as `any`; pin them down before use.
          const run = query as (args: unknown) => Prisma.PrismaPromise<unknown>;
          const tenantId = currentTenantId();

          let scopedArgs: unknown = args;
          if (model !== undefined && TENANT_SCOPED_MODELS.has(model)) {
            if (!tenantId) throw new MissingTenantContextError(`${model}.${operation}`);
            scopedArgs = scopeArgs(model, operation, scopedArgs, tenantId);
          }

          // Inside db.transaction() the tenant is already bound to the connection.
          if (!tenantId || currentTransaction()) return run(scopedArgs);

          const [, result] = await client.$transaction([
            client.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
            run(scopedArgs),
          ]);
          return result;
        },
      },
    }),
  );
}
