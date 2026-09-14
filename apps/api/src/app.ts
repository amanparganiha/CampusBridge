import cookie from '@fastify/cookie';
import Fastify, { LogController } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type FastifyPluginAsyncZod,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AccessTokenService } from './auth/access-tokens.js';
import { authenticationPlugin } from './auth/authenticate.js';
import type { PermissionResolver } from './auth/permission-resolver.js';
import type { SessionRevocation } from './auth/session-revocation.js';
import type { TenantQuota } from './auth/tenant-quota.js';
import type { Env } from './config/env.js';
import { apiKeyRoutes } from './modules/api-keys/api-keys.routes.js';
import type { ApiKeyService } from './modules/api-keys/api-keys.service.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import type { AuthService } from './modules/auth/auth.service.js';
import { oidcRoutes } from './modules/auth/oidc/oidc.routes.js';
import type { OidcService } from './modules/auth/oidc/oidc.service.js';
import { healthRoutes, type ReadinessCheck } from './modules/health/health.routes.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { metricsPlugin, type Metrics } from './plugins/metrics.js';
import { generateRequestId, requestContextPlugin } from './plugins/request-context.js';
import { securityPlugin } from './plugins/security.js';
import { swaggerPlugin } from './plugins/swagger.js';

/** Feature services behind /api/v1. Absent in tests of the bare HTTP platform. */
export interface ApiServices {
  tokens: AccessTokenService;
  auth: AuthService;
  oidc: OidcService;
  apiKeys: ApiKeyService;
  permissions: PermissionResolver;
  revocation: SessionRevocation;
  quota: TenantQuota;
  /** Callback URL registered with every school's identity provider. */
  oidcRedirectUri: string;
}

/** Everything the HTTP layer needs. Built by container.ts; tests pass fakes. */
export interface AppDependencies {
  env: Env;
  logger: Logger;
  metrics: Metrics;
  redis?: Redis | undefined;
  readinessChecks: readonly ReadinessCheck[];
  lifecycle: { isShuttingDown: () => boolean };
  api?: ApiServices | undefined;
}

const apiIndex: FastifyPluginAsyncZod = async (api) => {
  api.get(
    '/',
    {
      config: { auth: 'public' },
      schema: {
        tags: ['health'],
        summary: 'API index',
        response: {
          200: z.object({ name: z.string(), version: z.string(), documentation: z.string() }),
        },
      },
    },
    () => ({ name: 'CampusBridge API', version: 'v1', documentation: '/docs' }),
  );
};

function createFastify(env: Env, logger: Logger) {
  return Fastify({
    loggerInstance: logger,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: generateRequestId,
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();
}

export type App = ReturnType<typeof createFastify>;

/**
 * Creates the Fastify app without listening, so tests can drive it in-process. Plugin order
 * matters: request context and error handling first, OpenAPI before any route is declared.
 */
export async function buildApp(deps: AppDependencies): Promise<App> {
  const { env, api } = deps;
  const app = createFastify(env, deps.logger);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin, { env, redis: deps.redis });
  await app.register(cookie);
  await app.register(swaggerPlugin, { env });
  await app.register(metricsPlugin, { metrics: deps.metrics, token: env.METRICS_TOKEN });

  await app.register(healthRoutes, {
    checks: deps.readinessChecks,
    isShuttingDown: deps.lifecycle.isShuttingDown,
    exposeErrors: env.NODE_ENV !== 'production',
  });

  if (api) {
    // Public verification keys for access tokens (other services can validate them offline).
    app.get(
      '/.well-known/jwks.json',
      {
        config: { rateLimit: false },
        schema: {
          tags: ['auth'],
          summary: 'Public keys that sign access tokens (JWKS)',
          response: { 200: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }) },
        },
      },
      async (_request, reply) => {
        void reply.header('cache-control', 'public, max-age=300');
        return api.tokens.jwks;
      },
    );
  }

  await app.register(
    async (v1) => {
      // Secure by default: everything registered in this scope requires credentials unless a
      // route opts out with `config: { auth: 'public' }`.
      if (api) await v1.register(authenticationPlugin, api);
      await v1.register(apiIndex);
      if (api) {
        await v1.register(authRoutes, { prefix: '/auth', auth: api.auth, env });
        await v1.register(oidcRoutes, {
          prefix: '/auth/oidc',
          oidc: api.oidc,
          env,
          redirectUri: api.oidcRedirectUri,
        });
        await v1.register(apiKeyRoutes, { prefix: '/api-keys', apiKeys: api.apiKeys });
      }
    },
    { prefix: '/api/v1' },
  );

  return app;
}
