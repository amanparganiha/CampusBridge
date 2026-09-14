import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import type { Logger } from 'pino';
import { PrismaClient } from '../generated/prisma/client.js';

export interface DatabaseOptions {
  url: string;
  poolMax: number;
  /** Shows up in pg_stat_activity, so DBAs can attribute connections to a service. */
  applicationName: string;
}

/**
 * Prisma 7 talks to Postgres through a driver adapter over a node-postgres pool we own. Owning
 * the pool gives us its metrics (total/idle/waiting) and explicit control over shutdown.
 */
export function createDatabase(
  options: DatabaseOptions,
  logger: Logger,
): { pool: pg.Pool; prisma: PrismaClient } {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax,
    application_name: options.applicationName,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  const adapter = new PrismaPg(pool, {
    onPoolError: (err) => {
      logger.error({ err }, 'postgres pool error');
    },
  });

  const prisma = new PrismaClient({
    adapter,
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
    ],
  });
  prisma.$on('warn', (event) => {
    logger.warn({ prisma: event }, 'prisma warning');
  });
  prisma.$on('error', (event) => {
    logger.error({ prisma: event }, 'prisma error');
  });

  return { pool, prisma };
}
