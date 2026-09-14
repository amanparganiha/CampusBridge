import { pino } from 'pino';
import { buildApp, type App, type AppDependencies } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { createMetrics } from '../../src/plugins/metrics.js';

export const TEST_METRICS_TOKEN = 'test-metrics-token-0123456789';

export const testEnv = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://cb_app:unused@localhost:5432/unused',
  REDIS_URL: 'redis://localhost:6379',
  METRICS_TOKEN: TEST_METRICS_TOKEN,
});

/**
 * Builds the real app with in-memory fakes for I/O (no Postgres/Redis), for tests of the HTTP
 * platform layer. The app is returned un-ready so a test can register extra routes first.
 */
export async function buildTestApp(overrides: Partial<AppDependencies> = {}): Promise<App> {
  return buildApp({
    env: testEnv,
    logger: pino({ level: 'silent' }),
    metrics: createMetrics('campusbridge-test'),
    readinessChecks: [],
    lifecycle: { isShuttingDown: () => false },
    ...overrides,
  });
}
