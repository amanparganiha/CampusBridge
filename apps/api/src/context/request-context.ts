import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request (or per-job) context carried implicitly through async calls.
 *
 * Code deep in the call stack (the Prisma tenant extension, the audit logger) reads the current
 * request id and tenant from here instead of having them threaded through every signature.
 * The object is created once per request and mutated as information is resolved.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly ip: string;
  readonly userAgent: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}
