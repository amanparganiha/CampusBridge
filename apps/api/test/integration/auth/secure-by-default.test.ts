import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';

type Security = Record<string, string[]>[];
interface OpenApiDocument {
  paths: Record<string, Record<string, { security?: Security }>>;
}

/**
 * Routes that deliberately work without credentials. Adding a route here is a security review
 * decision; making any other route public fails this test.
 */
const PUBLIC_OPERATIONS = new Set([
  'GET /api/v1/',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'GET /api/v1/auth/oidc/{tenantSlug}/authorize',
  'GET /api/v1/auth/oidc/callback',
]);
const OPTIONAL_AUTH_OPERATIONS = new Set(['POST /api/v1/auth/logout']);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

describe('secure by default', () => {
  let testApp: TestApp;
  let operations: { key: string; method: string; path: string; security: Security | undefined }[];

  beforeAll(async () => {
    testApp = await startTestApp();
    const document = (await request(testApp.app.server).get('/docs/json').expect(200))
      .body as OpenApiDocument;
    operations = Object.entries(document.paths)
      .filter(([path]) => path.startsWith('/api/v1'))
      .flatMap(([path, methods]) =>
        Object.entries(methods)
          .filter(([method]) => HTTP_METHODS.has(method))
          .map(([method, operation]) => ({
            key: `${method.toUpperCase()} ${path}`,
            method,
            path,
            security: operation.security,
          })),
      );
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('documents a security requirement on every API operation', () => {
    expect(operations.length).toBeGreaterThan(5);
    expect(
      operations.filter((operation) => operation.security === undefined).map((o) => o.key),
    ).toEqual([]);
  });

  it('only the reviewed routes are public or optionally authenticated', () => {
    const open = operations
      .filter((operation) => operation.security?.length === 0)
      .map((o) => o.key);
    const optional = operations
      .filter((operation) =>
        operation.security?.some((requirement) => Object.keys(requirement).length === 0),
      )
      .map((o) => o.key);

    expect(new Set(open)).toEqual(PUBLIC_OPERATIONS);
    expect(new Set(optional)).toEqual(OPTIONAL_AUTH_OPERATIONS);
  });

  it('every other operation rejects anonymous callers with 401', async () => {
    const protectedOperations = operations.filter(
      (operation) =>
        !PUBLIC_OPERATIONS.has(operation.key) && !OPTIONAL_AUTH_OPERATIONS.has(operation.key),
    );
    expect(protectedOperations.length).toBeGreaterThan(3);

    for (const operation of protectedOperations) {
      const url = operation.path.replace(/\{[^}]+\}/g, '01a09e9a-0000-7000-8000-000000000000');
      const response = await request(testApp.app.server)[operation.method as 'get'](url).send({});
      expect(`${operation.key} -> ${String(response.status)}`).toBe(`${operation.key} -> 401`);
    }
  });
});
