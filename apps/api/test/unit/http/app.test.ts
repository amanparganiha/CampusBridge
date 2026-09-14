import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { App } from '../../../src/app.js';
import { currentContext } from '../../../src/context/request-context.js';
import { NotFoundError, type ProblemDetails } from '../../../src/lib/errors.js';
import { buildTestApp, TEST_METRICS_TOKEN } from '../../helpers/test-app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const problemOf = (response: Response) => response.body as ProblemDetails;

describe('HTTP platform', () => {
  let app: App;
  let shuttingDown = false;
  let databaseHealthy = true;

  beforeAll(async () => {
    app = await buildTestApp({
      readinessChecks: [
        {
          name: 'database',
          check: async () => {
            if (!databaseHealthy) throw new Error('connection refused');
          },
        },
      ],
      lifecycle: { isShuttingDown: () => shuttingDown },
    });

    // Test-only routes exercising validation, context propagation and error mapping.
    app.post(
      '/test/echo',
      { schema: { body: z.object({ email: z.email(), age: z.number().int().min(0) }) } },
      (req) => ({ echoed: req.body, requestIdFromContext: currentContext()?.requestId }),
    );
    app.get('/test/not-found', () => {
      throw new NotFoundError('Course not found.');
    });
    app.get('/test/crash', () => {
      throw new Error('secret internal detail');
    });
    app.get('/test/limited', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, () => ({
      ok: true,
    }));

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('health probes', () => {
    it('reports liveness', async () => {
      const response = await request(app.server).get('/health/live').expect(200);

      expect(response.body).toEqual({ status: 'ok' });
    });

    it('reports ready when every check passes', async () => {
      const response = await request(app.server).get('/health/ready').expect(200);

      expect(response.body).toMatchObject({ status: 'ok', checks: { database: { status: 'ok' } } });
    });

    it('returns 503 with the failing check when a dependency is down', async () => {
      databaseHealthy = false;
      try {
        const response = await request(app.server).get('/health/ready').expect(503);

        expect(response.body).toMatchObject({
          status: 'unavailable',
          checks: { database: { status: 'fail', error: 'connection refused' } },
        });
      } finally {
        databaseHealthy = true;
      }
    });

    it('returns 503 while draining for shutdown, even if dependencies are fine', async () => {
      shuttingDown = true;
      try {
        await request(app.server).get('/health').expect(503);
      } finally {
        shuttingDown = false;
      }
    });
  });

  describe('request ids', () => {
    it('generates a UUID and returns it in x-request-id', async () => {
      const response = await request(app.server).get('/health/live');

      expect(response.headers['x-request-id']).toMatch(UUID);
    });

    it('reuses a well-formed inbound id for cross-service correlation', async () => {
      const response = await request(app.server)
        .get('/health/live')
        .set('x-request-id', 'partner-trace-0001');

      expect(response.headers['x-request-id']).toBe('partner-trace-0001');
    });

    it('replaces an inbound id that could inject into logs', async () => {
      const response = await request(app.server)
        .get('/health/live')
        .set('x-request-id', 'evil"} {"level":"fatal');

      expect(response.headers['x-request-id']).toMatch(UUID);
    });

    it('makes the request context available to handlers after the body is parsed', async () => {
      const response = await request(app.server)
        .post('/test/echo')
        .send({ email: 'ada@lincoln.test', age: 36 })
        .expect(200);

      const body = response.body as { requestIdFromContext?: string };
      expect(body.requestIdFromContext).toBe(response.headers['x-request-id']);
    });
  });

  describe('problem details', () => {
    it('answers unknown routes with 404 problem+json', async () => {
      const response = await request(app.server).get('/api/v1/nope').expect(404);

      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).toEqual({
        type: 'urn:campusbridge:problem:route-not-found',
        title: 'Not Found',
        status: 404,
        code: 'ROUTE_NOT_FOUND',
        detail: 'No route matches GET /api/v1/nope.',
        instance: '/api/v1/nope',
        requestId: response.headers['x-request-id'],
      });
    });

    it('reports every invalid field with its location', async () => {
      const response = await request(app.server)
        .post('/test/echo')
        .send({ email: 'not-an-email', age: -1 })
        .expect(400);

      const problem = problemOf(response);
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.map((error) => error.path).sort()).toEqual(['body.age', 'body.email']);
    });

    it('rejects malformed JSON as a client error', async () => {
      const response = await request(app.server)
        .post('/test/echo')
        .set('content-type', 'application/json')
        .send('{"email":')
        .expect(400);

      expect(problemOf(response).code).toBe('BAD_REQUEST');
    });

    it('renders application errors with their status and detail', async () => {
      const response = await request(app.server).get('/test/not-found').expect(404);

      expect(response.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Course not found.' });
    });

    it('hides the details of unexpected errors', async () => {
      const response = await request(app.server).get('/test/crash').expect(500);

      expect(response.body).toMatchObject({
        code: 'INTERNAL_ERROR',
        detail: 'An unexpected error occurred.',
      });
      expect(JSON.stringify(response.body)).not.toContain('secret internal detail');
    });
  });

  describe('rate limiting', () => {
    it('returns 429 problem+json with Retry-After once the limit is exhausted', async () => {
      await request(app.server).get('/test/limited').expect(200);
      await request(app.server).get('/test/limited').expect(200);
      const response = await request(app.server).get('/test/limited').expect(429);

      expect(problemOf(response).code).toBe('RATE_LIMITED');
      expect(response.headers['retry-after']).toBeDefined();
    });
  });

  describe('security headers', () => {
    it('locks down browser behaviour for API responses', async () => {
      const response = await request(app.server).get('/health/live');

      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none';frame-ancestors 'none'",
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('metrics endpoint', () => {
    it('requires the scrape token', async () => {
      const response = await request(app.server).get('/metrics').expect(401);

      expect(problemOf(response).code).toBe('UNAUTHENTICATED');
      expect(response.headers['www-authenticate']).toBe('Bearer');
    });

    it('exposes Prometheus metrics labelled by route template', async () => {
      await request(app.server).get('/health/live');
      const response = await request(app.server)
        .get('/metrics')
        .set('authorization', `Bearer ${TEST_METRICS_TOKEN}`)
        .expect(200);

      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('http_request_duration_seconds_bucket');
      expect(response.text).toMatch(/route="\/health\/live"/);
    });
  });

  describe('OpenAPI document', () => {
    it('is generated from route schemas and omits internal endpoints', async () => {
      const response = await request(app.server).get('/docs/json').expect(200);
      const document = response.body as { openapi: string; paths: Record<string, unknown> };

      expect(document.openapi).toBe('3.1.0');
      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining(['/health/live', '/health/ready', '/api/v1/']),
      );
      expect(document.paths).not.toHaveProperty('/metrics');
    });
  });
});
