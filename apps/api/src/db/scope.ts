import { AsyncLocalStorage } from 'node:async_hooks';
import { currentContext } from '../context/request-context.js';

export class MissingTenantContextError extends Error {
  constructor(what: string) {
    super(
      `${what} requires a tenant context, but none is set. Run it within an authenticated request or runAsTenant().`,
    );
    this.name = 'MissingTenantContextError';
  }
}

export class TenantContextMismatchError extends Error {
  constructor(transactionTenantId: string, contextTenantId: string) {
    super(
      `A transaction bound to tenant ${transactionTenantId} was used while the context is tenant ${contextTenantId}.`,
    );
    this.name = 'TenantContextMismatchError';
  }
}

/** The interactive transaction currently in progress, and the tenant it is bound to. */
export interface TransactionScope {
  readonly tenantId: string;
  readonly client: unknown;
}

const transactions = new AsyncLocalStorage<TransactionScope>();

export function currentTransaction(): TransactionScope | undefined {
  return transactions.getStore();
}

export function runInTransactionScope<T>(scope: TransactionScope, fn: () => T): T {
  return transactions.run(scope, fn);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenant every database call in the current scope is bound to. A transaction's tenant is
 * fixed when it opens; entering a different tenant's context inside it is a programming error.
 */
export function currentTenantId(): string | undefined {
  const transaction = currentTransaction();
  const contextTenantId = currentContext()?.tenantId;
  if (transaction && contextTenantId && transaction.tenantId !== contextTenantId) {
    throw new TenantContextMismatchError(transaction.tenantId, contextTenantId);
  }
  const tenantId = transaction?.tenantId ?? contextTenantId;
  if (tenantId !== undefined && !UUID.test(tenantId)) {
    throw new Error(`Tenant context holds a malformed tenant id: ${JSON.stringify(tenantId)}`);
  }
  return tenantId;
}

export function requireTenantId(what = 'This operation'): string {
  const tenantId = currentTenantId();
  if (!tenantId) throw new MissingTenantContextError(what);
  return tenantId;
}
