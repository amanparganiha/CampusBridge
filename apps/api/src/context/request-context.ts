import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Per-request (or per-job) context carried implicitly through async calls.
 *
 * Code deep in the call stack (the Prisma tenant extension, the audit logger) reads the current
 * request id and tenant from here instead of having them threaded through every signature.
 * The object is created once per request and mutated as information is resolved (e.g. the tenant
 * after authentication).
 */
export interface RequestContext {
  readonly requestId: string;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  /** Set once the tenant is known; every tenant-scoped query is bound to it. */
  tenantId?: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` on behalf of one tenant: for background jobs, scripts and tests, which have no HTTP
 * request to resolve the tenant from. Inherits the current request id when there is one.
 *
 * The result is awaited *inside* the tenant scope. Prisma queries are lazy thenables that only
 * execute when awaited, so returning one unawaited would run it after the scope has ended,
 * i.e. with no tenant (which the tenant extension rejects).
 */
export function runAsTenant<T>(tenantId: string, fn: () => T | PromiseLike<T>): Promise<T> {
  const parent = currentContext();
  return runWithContext(
    {
      requestId: parent?.requestId ?? randomUUID(),
      ip: parent?.ip,
      userAgent: parent?.userAgent,
      tenantId,
    },
    async () => {
      const result = await fn();
      return result;
    },
  );
}
