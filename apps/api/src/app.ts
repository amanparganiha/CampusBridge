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
import type { TenantDb } from './db/tenant-db.js';
import { apiKeyRoutes } from './modules/api-keys/api-keys.routes.js';
import type { ApiKeyService } from './modules/api-keys/api-keys.service.js';
import { auditLogRoutes } from './modules/audit/audit-logs.routes.js';
import type { AuditLogsService } from './modules/audit/audit-logs.service.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import type { AuthService } from './modules/auth/auth.service.js';
import { oidcRoutes } from './modules/auth/oidc/oidc.routes.js';
import type { OidcService } from './modules/auth/oidc/oidc.service.js';
import { catalogRoutes, courseRoutes, sectionRoutes } from './modules/courses/courses.routes.js';
import type { CoursesService } from './modules/courses/courses.service.js';
import { enrollmentRoutes } from './modules/enrollments/enrollments.routes.js';
import type { EnrollmentsService } from './modules/enrollments/enrollments.service.js';
import { enrollmentGradeRoutes, gradeRoutes } from './modules/grades/grades.routes.js';
import type { GradesService } from './modules/grades/grades.service.js';
import { healthRoutes, type ReadinessCheck } from './modules/health/health.routes.js';
import { tenantRoutes } from './modules/tenants/tenants.routes.js';
import type { TenantsService } from './modules/tenants/tenants.service.js';
import { invitationPublicRoutes } from './modules/users/invitation-public.routes.js';
import type { InvitationsService } from './modules/users/invitations.service.js';
import { invitationRoutes, roleRoutes, userRoutes } from './modules/users/users.routes.js';
import type { UsersService } from './modules/users/users.service.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { idempotencyPlugin } from './plugins/idempotency.js';
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
  /** For idempotency-key records. */
  db: TenantDb;
  tenants: TenantsService;
  users: UsersService;
  invitations: InvitationsService;
  courses: CoursesService;
  enrollments: EnrollmentsService;
  grades: GradesService;
  auditLogs: AuditLogsService;
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
      if (api) {
        await v1.register(authenticationPlugin, api);
        // After authentication, so replays are scoped to the caller and permission checks run first.
        await v1.register(idempotencyPlugin, { db: api.db, logger: deps.logger });
      }
      await v1.register(apiIndex);
      if (api) {
        await v1.register(authRoutes, { prefix: '/auth', auth: api.auth, env });
        await v1.register(oidcRoutes, {
          prefix: '/auth/oidc',
          oidc: api.oidc,
          env,
          redirectUri: api.oidcRedirectUri,
        });
        await v1.register(invitationPublicRoutes, {
          prefix: '/auth/invitations',
          invitations: api.invitations,
          env,
        });
        await v1.register(apiKeyRoutes, { prefix: '/api-keys', apiKeys: api.apiKeys });
        await v1.register(tenantRoutes, { prefix: '/tenants', tenants: api.tenants, env });
        await v1.register(userRoutes, {
          prefix: '/users',
          users: api.users,
          invitations: api.invitations,
        });
        await v1.register(roleRoutes, { prefix: '/roles', users: api.users });
        await v1.register(invitationRoutes, {
          prefix: '/invitations',
          invitations: api.invitations,
        });
        await v1.register(courseRoutes, { prefix: '/courses', courses: api.courses });
        await v1.register(sectionRoutes, { prefix: '/sections', courses: api.courses });
        await v1.register(catalogRoutes, { prefix: '/catalog', courses: api.courses });
        await v1.register(enrollmentRoutes, {
          prefix: '/enrollments',
          enrollments: api.enrollments,
        });
        await v1.register(enrollmentGradeRoutes, { prefix: '/enrollments', grades: api.grades });
        await v1.register(gradeRoutes, { prefix: '/grades', grades: api.grades });
        await v1.register(auditLogRoutes, { prefix: '/audit-logs', auditLogs: api.auditLogs });
      }
    },
    { prefix: '/api/v1' },
  );

  return app;
}
