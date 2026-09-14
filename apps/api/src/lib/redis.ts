import { Redis } from 'ioredis';
import type { Logger } from 'pino';

/**
 * General-purpose Redis client for request-path work (rate limits, caches, session revocation).
 *
 * It fails fast rather than queueing while disconnected, because a request must never hang on
 * Redis: callers either degrade (rate limiting fails open) or return 503. BullMQ uses separate
 * connections with blocking semantics (see jobs/).
 */
export function createRedis(url: string, name: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    connectionName: `campusbridge-${name}`,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2_000,
    connectTimeout: 5_000,
  });
  redis.on('error', (err) => {
    logger.warn({ err }, 'redis connection error');
  });
  return redis;
}
