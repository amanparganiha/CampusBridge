import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { TenantDb } from '../db/tenant-db.js';

/**
 * Makes logout immediate even though access tokens are stateless JWTs.
 *
 * Revoked session ids are kept in Redis for as long as an access token can live, and every
 * authenticated request checks it (one O(1) lookup). If Redis is unreachable, the check falls
 * back to the sessions table: slower, but never wrong, which matters more for security than
 * for rate limiting (which fails open).
 */
export class SessionRevocation {
  constructor(
    private readonly redis: Redis,
    private readonly db: TenantDb,
    private readonly logger: Logger,
    private readonly accessTokenTtlSeconds: number,
  ) {}

  static key(sessionId: string): string {
    return `cb:session-revoked:${sessionId}`;
  }

  async markRevoked(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    try {
      const pipeline = this.redis.multi();
      for (const id of sessionIds)
        pipeline.set(SessionRevocation.key(id), '1', 'EX', this.accessTokenTtlSeconds + 60);
      await pipeline.exec();
    } catch (err) {
      // The database already records the revocation; checks fall back to it.
      this.logger.warn({ err, sessionIds }, 'could not cache session revocation in redis');
    }
  }

  /** Must run in the session's tenant context (for the database fallback). */
  async isRevoked(sessionId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(SessionRevocation.key(sessionId))) === 1;
    } catch (err) {
      this.logger.warn(
        { err },
        'redis unavailable for revocation check; falling back to the database',
      );
      const session = await this.db.client.session.findUnique({
        where: { id: sessionId },
        select: { revokedAt: true, expiresAt: true },
      });
      // Missing, revoked or expired all count as revoked.
      return session?.revokedAt !== null || session.expiresAt <= new Date();
    }
  }
}
