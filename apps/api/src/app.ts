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
import type { Env } from './config/env.js';
import { healthRoutes, type ReadinessCheck } from './modules/health/health.routes.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { metricsPlugin, type Metrics } from './plugins/metrics.js';
import { generateRequestId, requestContextPlugin } from './plugins/request-context.js';
import { securityPlugin } from './plugins/security.js';
import { swaggerPlugin } from './plugins/swagger.js';

/** Everything the HTTP layer needs. Built by container.ts; tests pass fakes. */
export interface AppDependencies {
  env: Env;
  logger: Logger;
  metrics: Metrics;
  redis?: Redis | undefined;
  readinessChecks: readonly ReadinessCheck[];
  lifecycle: { isShuttingDown: () => boolean };
}

const apiIndex: FastifyPluginAsyncZod = async (api) => {
  api.get(
    '/',
    {
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
  const { env } = deps;
  const app = createFastify(env, deps.logger);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin, { env, redis: deps.redis });
  await app.register(swaggerPlugin, { env });
  await app.register(metricsPlugin, { metrics: deps.metrics, token: env.METRICS_TOKEN });

  await app.register(healthRoutes, {
    checks: deps.readinessChecks,
    isShuttingDown: deps.lifecycle.isShuttingDown,
    exposeErrors: env.NODE_ENV !== 'production',
  });

  await app.register(apiIndex, { prefix: '/api/v1' });

  return app;
}
