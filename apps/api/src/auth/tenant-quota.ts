import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { TooManyRequestsError } from '../lib/errors.js';

/**
 * Per-school request budget, on top of the per-caller rate limit. In a shared-schema
 * multi-tenant system this is the first line of defence against a noisy neighbour: one school's
 * runaway integration cannot consume the capacity every other school depends on.
 * Fixed one-minute windows; fails open if Redis is unavailable.
 */
export class TenantQuota {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly limitPerMinute: number,
  ) {}

  async consume(tenantId: string): Promise<void> {
    const window = Math.floor(Date.now() / 60_000);
    const key = `cb:tenant-quota:${tenantId}:${String(window)}`;
    let count: number;
    try {
      const results = await this.redis.multi().incr(key).expire(key, 120, 'NX').exec();
      count = Number(results?.[0]?.[1] ?? 0);
    } catch (err) {
      this.logger.warn({ err }, 'tenant quota unavailable');
      return;
    }
    if (count > this.limitPerMinute) {
      const retryAfter = 60 - Math.floor((Date.now() / 1000) % 60);
      throw new TooManyRequestsError('Your school has exceeded its request quota. Retry shortly.', {
        code: 'TENANT_RATE_LIMITED',
        headers: { 'retry-after': String(retryAfter) },
      });
    }
  }
}
