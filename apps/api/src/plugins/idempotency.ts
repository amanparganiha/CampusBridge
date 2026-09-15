import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { Logger } from 'pino';
import { requirePrincipal } from '../auth/authenticate.js';
import type { TenantDb } from '../db/tenant-db.js';
import { Prisma } from '../generated/prisma/client.js';
import { canonicalJson, sha256 } from '../lib/crypto/hash.js';
import { BadRequestError, ConflictError, UnprocessableError } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Honour the Idempotency-Key header on this route (for side-effecting POSTs). */
    idempotent?: boolean;
  }
  interface FastifyRequest {
    idempotencyRecordId: string | undefined;
  }
}

export interface IdempotencyOptions {
  db: TenantDb;
  logger: Logger;
  /** How long a stored response can be replayed. */
  ttlMs?: number;
  /** An unfinished claim older than this is treated as abandoned (the process died mid-request). */
  staleAfterMs?: number;
}

const KEY_FORMAT = /^[\x21-\x7e]{1,255}$/;

/**
 * Idempotency keys (the Stripe convention): a client retrying a POST after a timeout sends the
 * same `Idempotency-Key`, and gets the original response instead of a second enrollment, invite
 * or charge. Keys are scoped to the tenant and the caller, so they can never collide across
 * schools or users.
 *
 * - Same key, same request, finished: the stored response is replayed (`Idempotent-Replayed`).
 * - Same key, different request: 422, because the client has a bug and must not silently get
 *   someone else's result.
 * - Same key, still running: 409 with Retry-After. A claim older than `staleAfterMs` is taken
 *   over so a crashed request cannot block the key until it expires.
 * - 5xx outcomes are not stored, so the client can retry them.
 */
const idempotencyPluginImpl: FastifyPluginAsync<IdempotencyOptions> = async (app, options) => {
  const { db } = options;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const staleAfterMs = options.staleAfterMs ?? 60_000;

  app.decorateRequest('idempotencyRecordId', undefined);

  app.addHook('preHandler', async (request, reply) => {
    if (!request.routeOptions.config.idempotent) return;
    const key = request.headers['idempotency-key'];
    if (key === undefined) return;
    if (typeof key !== 'string' || !KEY_FORMAT.test(key)) {
      throw new BadRequestError('Idempotency-Key must be 1-255 visible ASCII characters.', {
        code: 'INVALID_IDEMPOTENCY_KEY',
      });
    }

    const principal = requirePrincipal(request);
    const principalId = principal.kind === 'user' ? principal.userId : principal.apiKeyId;
    const requestHash = sha256(`${request.method} ${request.url} ${canonicalJson(request.body)}`);
    const now = new Date();

    try {
      const claimed = await db.client.idempotencyKey.create({
        data: {
          tenantId: principal.tenantId,
          principalId,
          key,
          method: request.method,
          path: request.url,
          requestHash,
          expiresAt: new Date(now.getTime() + ttlMs),
        },
      });
      request.idempotencyRecordId = claimed.id;
      return;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error;
    }

    const existing = await db.client.idempotencyKey.findUnique({
      where: { tenantId_principalId_key: { tenantId: principal.tenantId, principalId, key } },
    });
    if (existing && existing.requestHash !== requestHash) {
      throw new UnprocessableError(
        'This Idempotency-Key was already used for a different request.',
        {
          code: 'IDEMPOTENCY_KEY_REUSED',
        },
      );
    }
    if (existing?.completedAt && existing.statusCode !== null) {
      void reply
        .status(existing.statusCode)
        .header('idempotent-replayed', 'true')
        .type(existing.statusCode >= 400 ? 'application/problem+json' : 'application/json');
      return reply.send(existing.responseBody);
    }
    if (existing && now.getTime() - existing.createdAt.getTime() > staleAfterMs) {
      // Take over an abandoned claim, atomically: only one retry can win it.
      const takeover = await db.client.idempotencyKey.updateMany({
        where: { id: existing.id, completedAt: null, createdAt: existing.createdAt },
        data: { createdAt: now },
      });
      if (takeover.count === 1) {
        request.idempotencyRecordId = existing.id;
        return;
      }
    }
    throw new ConflictError('A request with this Idempotency-Key is still being processed.', {
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
      headers: { 'retry-after': '1' },
    });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const recordId = request.idempotencyRecordId;
    if (!recordId) return payload;
    try {
      if (reply.statusCode >= 500) {
        await db.client.idempotencyKey.delete({ where: { id: recordId } });
      } else {
        let body: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
        if (typeof payload === 'string' && payload.length > 0) {
          try {
            body = JSON.parse(payload) as Prisma.InputJsonValue;
          } catch {
            body = Prisma.JsonNull;
          }
        }
        await db.client.idempotencyKey.update({
          where: { id: recordId },
          data: { statusCode: reply.statusCode, responseBody: body, completedAt: new Date() },
        });
      }
    } catch (err) {
      // Never fail the response over bookkeeping; a stale claim is reclaimed after staleAfterMs.
      options.logger.error({ err, recordId }, 'could not record idempotent response');
    }
    return payload;
  });
};

export const idempotencyPlugin = fp(idempotencyPluginImpl, {
  name: 'idempotency',
  dependencies: ['authentication'],
});
