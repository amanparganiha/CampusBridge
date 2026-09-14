import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import { TooManyRequestsError } from '../lib/errors.js';

export interface SecurityPluginOptions {
  env: Env;
  /** Shared rate-limit store. Without it, limits are per-process (fine for unit tests only). */
  redis?: Redis;
}

const securityPluginImpl: FastifyPluginAsync<SecurityPluginOptions> = async (
  app,
  { env, redis },
) => {
  await app.register(helmet, {
    // This is a JSON API: nothing it serves should execute or be framed. /docs relaxes this for
    // its own page (see plugins/swagger.ts).
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  // The admin SPA is served from the same origin as the API, so CORS stays closed unless extra
  // browser origins are explicitly configured.
  await app.register(cors, {
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    credentials: true,
    exposedHeaders: [
      'x-request-id',
      'retry-after',
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
    ],
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Runs after authentication (added in P3) so limits can be keyed per tenant and principal.
    hook: 'preHandler',
    ...(redis ? { redis } : {}),
    nameSpace: 'cb:ratelimit:',
    // Availability over strictness: if Redis is unreachable, serve the request unthrottled.
    skipOnError: true,
    enableDraftSpec: true,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) =>
      new TooManyRequestsError(`Rate limit exceeded. Retry in ${context.after}.`),
  });

  await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip'] });
};

export const securityPlugin = fp(securityPluginImpl, { name: 'security' });
