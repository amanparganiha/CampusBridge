import { createHash, timingSafeEqual } from 'node:crypto';
import { Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import { UnauthorizedError } from '../lib/errors.js';

export interface Metrics {
  registry: Registry;
  httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
}

/** One registry per process (and per test app), so tests never share global metric state. */
export function createMetrics(service: string): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });

  const httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency, labelled by route template (never the raw URL, which would explode cardinality).',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  return { registry, httpRequestDuration };
}

export interface MetricsPluginOptions {
  metrics: Metrics;
  /** When set, scrapes must send `Authorization: Bearer <token>`. Required in production. */
  token?: string | undefined;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time comparison (hashing first equalises lengths). */
function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(token));
}

const metricsPluginImpl: FastifyPluginCallback<MetricsPluginOptions> = (
  app,
  { metrics, token },
  done,
) => {
  app.addHook('onResponse', (request, reply, next) => {
    metrics.httpRequestDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
    next();
  });

  app.get(
    '/metrics',
    { schema: { hide: true }, config: { rateLimit: false } },
    async (request, reply) => {
      if (token && !bearerMatches(request.headers.authorization, token)) {
        throw new UnauthorizedError('A valid metrics token is required.');
      }
      void reply.type(metrics.registry.contentType);
      return metrics.registry.metrics();
    },
  );

  done();
};

export const metricsPlugin = fp(metricsPluginImpl, { name: 'metrics' });
