import type pg from 'pg';
import type { AppDependencies } from './app.js';
import type { Env } from './config/env.js';
import { createDatabase } from './db/prisma.js';
import { createTenantDb, type TenantDb } from './db/tenant-db.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { createLogger } from './lib/logger.js';
import { createRedis } from './lib/redis.js';
import { createMetrics } from './plugins/metrics.js';

/**
 * Composition root: the one place that knows how concrete dependencies are built and wired.
 * Everything else receives what it needs, so tests can substitute fakes without module mocking.
 */
export interface Container extends AppDependencies {
  /** Raw client: readiness checks and wiring only. Feature code uses `db`. */
  prisma: PrismaClient;
  /** Tenant-scoped, RLS-enforced database access for all feature code. */
  db: TenantDb;
  pool: pg.Pool;
  lifecycle: AppDependencies['lifecycle'] & { beginShutdown: () => void };
  close: () => Promise<void>;
}

export function createContainer(env: Env): Container {
  const service = 'campusbridge-api';
  const logger = createLogger(env, service);
  const metrics = createMetrics(service);
  const { pool, prisma } = createDatabase(
    { url: env.DATABASE_URL, poolMax: env.DB_POOL_MAX, applicationName: service },
    logger,
  );
  const redis = createRedis(env.REDIS_URL, 'api', logger);
  const db = createTenantDb(prisma);

  let shuttingDown = false;

  return {
    env,
    logger,
    metrics,
    redis,
    prisma,
    db,
    pool,
    readinessChecks: [
      {
        name: 'database',
        check: async () => {
          await prisma.$queryRaw`SELECT 1`;
        },
      },
      {
        name: 'redis',
        check: async () => {
          await redis.ping();
        },
      },
    ],
    lifecycle: {
      isShuttingDown: () => shuttingDown,
      beginShutdown: () => {
        shuttingDown = true;
      },
    },
    close: async () => {
      await prisma.$disconnect();
      await pool.end();
      redis.disconnect();
    },
  };
}
