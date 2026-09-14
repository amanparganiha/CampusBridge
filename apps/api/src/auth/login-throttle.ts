import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { sha256 } from '../lib/crypto/hash.js';

/**
 * Limits password guessing per school + email address.
 *
 * Counting attempts per *email*, whether or not an account exists, means a locked-out response
 * reveals nothing about which accounts are real (an account-based lockout would). Emails are
 * hashed so Redis never holds personal data. Complements the per-IP rate limit on the route.
 */
export class LoginThrottle {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly maxFailures: number,
    private readonly windowSeconds: number,
  ) {}

  #key(tenantId: string, email: string): string {
    return `cb:login-failures:${tenantId}:${sha256(email)}`;
  }

  async isBlocked(tenantId: string, email: string): Promise<boolean> {
    try {
      return Number(await this.redis.get(this.#key(tenantId, email))) >= this.maxFailures;
    } catch (err) {
      // Fail open: argon2's cost and the per-IP limit still slow an attacker down.
      this.logger.warn({ err }, 'login throttle unavailable');
      return false;
    }
  }

  async recordFailure(tenantId: string, email: string): Promise<void> {
    const key = this.#key(tenantId, email);
    try {
      // The window starts at the first failure (NX), so steady guessing cannot keep it open.
      await this.redis.multi().incr(key).expire(key, this.windowSeconds, 'NX').exec();
    } catch (err) {
      this.logger.warn({ err }, 'login throttle unavailable');
    }
  }

  async reset(tenantId: string, email: string): Promise<void> {
    try {
      await this.redis.del(this.#key(tenantId, email));
    } catch (err) {
      this.logger.warn({ err }, 'login throttle unavailable');
    }
  }
}
