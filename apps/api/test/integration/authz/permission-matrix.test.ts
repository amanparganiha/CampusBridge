import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProblemDetails } from '../../../src/lib/errors.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { connectTestDatabases, type TestDatabases } from '../helpers/database.js';
import { as, createSchool, type SchoolFixture } from '../helpers/school.js';

type Role = 'admin' | 'instructor' | 'student';

interface OpenApiDocument {
  paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
}

const EVERYONE: readonly Role[] = ['admin', 'instructor', 'student'];
const STAFF: readonly Role[] = ['admin', 'instructor'];
const ADMIN: readonly Role[] = ['admin'];

/**
 * Which system roles pass the RBAC gate of each route. This is the reviewed contract: changing a
 * route's permissions, or a system role's grants, fails this test until the table is updated.
 * (Record-level rules, e.g. "only your own courses", are ABAC and tested per module.)
 */
const MATRIX: Record<string, readonly Role[]> = {
  'GET /api/v1/tenants/current': EVERYONE,
  'PATCH /api/v1/tenants/current': ADMIN,
  'GET /api/v1/users/': STAFF,
  'GET /api/v1/users/{id}': STAFF,
  'PATCH /api/v1/users/{id}': ADMIN,
  'PUT /api/v1/users/{id}/roles': ADMIN,
  'POST /api/v1/users/invite': ADMIN,
  'GET /api/v1/roles/': ADMIN,
  'GET /api/v1/invitations/': ADMIN,
  'DELETE /api/v1/invitations/{id}': ADMIN,
  'GET /api/v1/api-keys/': ADMIN,
  'POST /api/v1/api-keys/': ADMIN,
  'DELETE /api/v1/api-keys/{id}': ADMIN,
  'GET /api/v1/courses/': EVERYONE,
  'POST /api/v1/courses/': STAFF,
  'GET /api/v1/courses/{id}': EVERYONE,
  'PATCH /api/v1/courses/{id}': STAFF,
  'POST /api/v1/courses/{id}/publish': STAFF,
  'POST /api/v1/courses/{id}/archive': STAFF,
  'DELETE /api/v1/courses/{id}': STAFF,
  'POST /api/v1/courses/{id}/sections': STAFF,
  'PATCH /api/v1/sections/{id}': STAFF,
  'DELETE /api/v1/sections/{id}': STAFF,
  'GET /api/v1/catalog/': EVERYONE,
  'GET /api/v1/enrollments/': EVERYONE,
  'POST /api/v1/enrollments/': EVERYONE,
  'GET /api/v1/enrollments/{id}': EVERYONE,
  'PATCH /api/v1/enrollments/{id}': EVERYONE,
  'GET /api/v1/enrollments/{id}/grades': EVERYONE,
  'POST /api/v1/enrollments/{id}/grades': STAFF,
  'PATCH /api/v1/grades/{id}': STAFF,
  'DELETE /api/v1/grades/{id}': STAFF,
  'GET /api/v1/audit-logs/': ADMIN,
  'GET /api/v1/audit-logs/export': ADMIN,
};

/** Authenticated routes that every signed-in principal may call (they act on the caller). */
const UNGATED = new Set(['GET /api/v1/auth/me', 'POST /api/v1/auth/logout-all']);

const PLACEHOLDER_ID = '01a09e9a-0000-7000-8000-000000000000';

describe('role × route permission matrix', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: SchoolFixture;
  let protectedOperations: string[];

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    school = await createSchool(dbs, testApp.app, 'matrix');
    const document = (await request(testApp.app.server).get('/docs/json').expect(200))
      .body as OpenApiDocument;
    protectedOperations = Object.entries(document.paths)
      .filter(([path]) => path.startsWith('/api/v1'))
      .flatMap(([path, methods]) =>
        Object.entries(methods)
          .filter(
            ([, operation]) =>
              operation.security?.length === 1 &&
              Object.keys(operation.security[0] ?? {}).length > 0,
          )
          .map(([method]) => `${method.toUpperCase()} ${path}`),
      );
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  it('has an entry for every authenticated route', () => {
    const covered = new Set([...Object.keys(MATRIX), ...UNGATED]);
    expect(protectedOperations.filter((operation) => !covered.has(operation))).toEqual([]);
    expect([...covered].filter((operation) => !protectedOperations.includes(operation))).toEqual(
      [],
    );
  });

  const cases = Object.entries(MATRIX).flatMap(([operation, allowed]) =>
    EVERYONE.map((role) => ({ operation, role, allowed: allowed.includes(role) })),
  );

  it.each(cases)('$role → $operation: allowed=$allowed', async ({ operation, role, allowed }) => {
    const [method, template] = operation.split(' ') as [string, string];
    const url = template.replace('{id}', PLACEHOLDER_ID);
    // An empty body: allowed callers get past RBAC and fail validation or lookup (never 403
    // PERMISSION_DENIED); denied callers are stopped before the body is even validated.
    const response = await as(testApp.app, school[role])
      [method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](url)
      .send(method === 'GET' || method === 'DELETE' ? undefined : {});

    const denied =
      response.status === 403 && (response.body as ProblemDetails).code === 'PERMISSION_DENIED';
    expect({ operation, role, status: response.status, denied }).toMatchObject({
      denied: !allowed,
    });
  });

  it('limits an API key to exactly its scopes', async () => {
    const { token } = (
      await as(testApp.app, school.admin)
        .post('/api/v1/api-keys')
        .send({ name: 'Catalog reader', scopes: ['course:read'] })
        .expect(201)
    ).body as { token: string };

    await as(testApp.app, token).get('/api/v1/courses').expect(200);
    await as(testApp.app, token).get('/api/v1/catalog').expect(200);
    for (const [method, url] of [
      ['post', '/api/v1/courses'],
      ['get', '/api/v1/enrollments'],
      ['get', '/api/v1/users'],
      ['get', '/api/v1/audit-logs'],
    ] as const) {
      const response = await as(testApp.app, token)
        [method](url)
        .send(method === 'post' ? {} : undefined);
      expect(`${method} ${url} -> ${String(response.status)}`).toBe(`${method} ${url} -> 403`);
    }
  });
});
