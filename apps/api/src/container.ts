import type pg from 'pg';
import type { ApiServices, AppDependencies } from './app.js';
import { AccessTokenService } from './auth/access-tokens.js';
import { LoginThrottle } from './auth/login-throttle.js';
import { PermissionResolver } from './auth/permission-resolver.js';
import { SessionRevocation } from './auth/session-revocation.js';
import { TenantQuota } from './auth/tenant-quota.js';
import type { Env } from './config/env.js';
import { loadSecrets, type AppSecrets } from './config/secrets.js';
import { createDatabase } from './db/prisma.js';
import { createTenantDb, type TenantDb } from './db/tenant-db.js';
import { TenantDirectory } from './db/tenant-directory.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { Encryptor } from './lib/crypto/encryption.js';
import { createLogger } from './lib/logger.js';
import { createRedis } from './lib/redis.js';
import { ApiKeyService } from './modules/api-keys/api-keys.service.js';
import { AuditLogger } from './modules/audit/audit.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { OidcService } from './modules/auth/oidc/oidc.service.js';
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
  encryptor: Encryptor;
  api: ApiServices;
  lifecycle: AppDependencies['lifecycle'] & { beginShutdown: () => void };
  close: () => Promise<void>;
}

export interface ContainerOptions {
  /** Pre-generated secrets (tests); otherwise from the environment or the dev secrets file. */
  secrets?: AppSecrets;
}

export async function createContainer(
  env: Env,
  options: ContainerOptions = {},
): Promise<Container> {
  const service = 'campusbridge-api';
  const logger = createLogger(env, service);
  const metrics = createMetrics(service);
  const secrets = options.secrets ?? (await loadSecrets(env));
  const { pool, prisma } = createDatabase(
    { url: env.DATABASE_URL, poolMax: env.DB_POOL_MAX, applicationName: service },
    logger,
  );
  const redis = createRedis(env.REDIS_URL, 'api', logger);
  const db = createTenantDb(prisma);
  const encryptor = new Encryptor(secrets.encryptionKeys);
  const directory = new TenantDirectory(prisma);
  const audit = new AuditLogger(db);

  const tokens = await AccessTokenService.create(secrets.jwtPrivateJwks, {
    issuer: env.JWT_ISSUER ?? env.PUBLIC_API_URL,
    audience: env.JWT_AUDIENCE,
    ttlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  });
  const permissions = new PermissionResolver(db);
  const revocation = new SessionRevocation(redis, db, logger, env.ACCESS_TOKEN_TTL_SECONDS);
  const auth = new AuthService({
    db,
    directory,
    tokens,
    permissions,
    revocation,
    throttle: new LoginThrottle(
      redis,
      logger,
      env.LOGIN_MAX_FAILURES,
      env.LOGIN_FAILURE_WINDOW_SECONDS,
    ),
    audit,
    config: {
      sessionTtlSeconds: env.SESSION_TTL_SECONDS,
      refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
    },
    logger,
  });
  const oidcRedirectUri = new URL('/api/v1/auth/oidc/callback', env.PUBLIC_API_URL).href;

  let shuttingDown = false;

  return {
    env,
    logger,
    metrics,
    redis,
    prisma,
    db,
    pool,
    encryptor,
    api: {
      tokens,
      auth,
      oidc: new OidcService({
        db,
        directory,
        redis,
        encryptor,
        auth,
        audit,
        logger,
        redirectUri: oidcRedirectUri,
        allowInsecureRequests: env.NODE_ENV !== 'production',
      }),
      apiKeys: new ApiKeyService({ db, audit, logger }),
      permissions,
      revocation,
      quota: new TenantQuota(redis, logger, env.TENANT_RATE_LIMIT_PER_MINUTE),
      oidcRedirectUri,
    },
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
