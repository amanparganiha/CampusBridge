import type { ITXClientDenyList } from '@prisma/client/runtime/client';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import {
  currentTransaction,
  requireTenantId,
  runInTransactionScope,
  TenantContextMismatchError,
} from './scope.js';
import { tenantIsolation } from './tenant-extension.js';

function extend(base: PrismaClient) {
  return base.$extends(tenantIsolation());
}

export type TenantScopedClient = ReturnType<typeof extend>;
/** What services query through: the ambient transaction or the tenant-scoped client. */
export type DbClient = Omit<TenantScopedClient, ITXClientDenyList>;

export interface TransactionOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
}

/**
 * The only database handle feature code receives. Every query runs as the runtime role
 * (`cb_app`) under row-level security, scoped to the tenant in the current context.
 */
export interface TenantDb {
  /** The ambient transaction inside `transaction()`, otherwise the tenant-scoped client. */
  readonly client: DbClient;
  /**
   * Runs `fn` in one database transaction bound to the current tenant. Nested calls join the
   * outer transaction, so services compose without knowing who opened it.
   */
  transaction<T>(fn: (tx: DbClient) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

export function createTenantDb(base: PrismaClient): TenantDb {
  const scoped = extend(base);

  return {
    get client(): DbClient {
      return (currentTransaction()?.client as DbClient | undefined) ?? scoped;
    },

    async transaction<T>(
      fn: (tx: DbClient) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      const tenantId = requireTenantId('A database transaction');

      const ambient = currentTransaction();
      if (ambient) {
        if (ambient.tenantId !== tenantId)
          throw new TenantContextMismatchError(ambient.tenantId, tenantId);
        return fn(ambient.client as DbClient);
      }

      return scoped.$transaction(
        (tx) =>
          runInTransactionScope({ tenantId, client: tx }, async () => {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
            // Await inside the scope: `fn` may return a lazy Prisma query (see runAsTenant).
            const result = await fn(tx);
            return result;
          }),
        options,
      );
    },
  };
}
