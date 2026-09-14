import request from 'supertest';
import { inject } from 'vitest';
import { buildApp, type App } from '../../../src/app.js';
import { parseEnv } from '../../../src/config/env.js';
import { generateSecrets, type AppSecrets } from '../../../src/config/secrets.js';
import { createContainer, type Container } from '../../../src/container.js';

export interface TestApp {
  app: App;
  container: Container;
  close: () => Promise<void>;
}

export interface SessionBody {
  tokenType: 'Bearer';
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  refreshTokenExpiresAt: string;
  user: { id: string; email: string; name: string };
  tenant: { id: string; slug: string; name: string };
  roles: string[];
  permissions: string[];
}

export const TEST_PUBLIC_API_URL = 'http://api.campusbridge.test';
export const TEST_ADMIN_URL = 'http://admin.campusbridge.test';

let secrets: Promise<AppSecrets> | undefined;

/** The signing and encryption keys every test app in this file shares. */
export function testSecrets(): Promise<AppSecrets> {
  secrets ??= generateSecrets();
  return secrets;
}

/**
 * The real application (container + HTTP layer) against the Testcontainers Postgres and Redis.
 * Rate limits are raised so parallel test files sharing 127.0.0.1 do not trip them; the tests
 * for those limits set their own.
 */
export async function startTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const env = parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('database').appUrl,
    REDIS_URL: inject('redisUrl'),
    METRICS_TOKEN: 'integration-metrics-token',
    PUBLIC_API_URL: TEST_PUBLIC_API_URL,
    ADMIN_URL: TEST_ADMIN_URL,
    RATE_LIMIT_PER_MINUTE: '100000',
    LOGIN_RATE_LIMIT_PER_MINUTE: '100000',
    TENANT_RATE_LIMIT_PER_MINUTE: '100000',
    ...overrides,
  });
  const container = await createContainer(env, { secrets: await testSecrets() });
  const app = await buildApp(container);
  await app.ready();
  return {
    app,
    container,
    close: async () => {
      await app.close();
      await container.close();
    },
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Password login with the refresh token in the body (API-client mode). */
export async function login(
  app: App,
  credentials: { tenant: string; email: string; password: string },
): Promise<SessionBody> {
  const response = await request(app.server)
    .post('/api/v1/auth/login')
    .send({ ...credentials, tokenDelivery: 'body' })
    .expect(200);
  return response.body as SessionBody;
}
