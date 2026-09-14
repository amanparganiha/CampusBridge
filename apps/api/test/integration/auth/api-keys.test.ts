import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProblemDetails } from '../../../src/lib/errors.js';
import type { ProvisionedTenant } from '../../../src/modules/tenants/provisioning.js';
import { bearer, login, startTestApp, type TestApp } from '../helpers/app.js';
import {
  connectTestDatabases,
  createTestTenant,
  createTestUser,
  TEST_PASSWORD,
  type TestDatabases,
} from '../helpers/database.js';

interface CreatedKey {
  apiKey: { id: string; name: string; hint: string; scopes: string[]; lastUsedAt: string | null };
  token: string;
}

const problem = (response: request.Response) => response.body as ProblemDetails;

describe('API keys for partner systems', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: ProvisionedTenant;
  let otherSchool: ProvisionedTenant;
  let adminToken: string;

  const http = () => request(testApp.app.server);
  const createKey = (token: string, body: Record<string, unknown>) =>
    http().post('/api/v1/api-keys').set(bearer(token)).send(body);

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    school = await createTestTenant(dbs.owner, 'keys');
    otherSchool = await createTestTenant(dbs.owner, 'keys-other');
    adminToken = (
      await login(testApp.app, {
        tenant: school.tenant.slug,
        email: school.admin.email,
        password: TEST_PASSWORD,
      })
    ).accessToken;
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  it('returns the secret once and stores only its hash', async () => {
    const response = await createKey(adminToken, {
      name: 'SIS sync',
      scopes: ['course:read', 'enrollment:read'],
    }).expect(201);
    const created = response.body as CreatedKey;

    expect(created.token).toMatch(new RegExp(`^cbk_${school.tenant.id}_`));
    expect(created.apiKey).toMatchObject({
      name: 'SIS sync',
      scopes: ['course:read', 'enrollment:read'],
    });
    expect(created.token.endsWith(created.apiKey.hint)).toBe(true);

    const stored = await dbs.owner.apiKey.findUniqueOrThrow({ where: { id: created.apiKey.id } });
    expect(stored.keyHash).not.toContain(created.token);
    const listed = await http().get('/api/v1/api-keys').set(bearer(adminToken)).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(created.token);
  });

  it('authenticates a partner system with exactly the key’s scopes', async () => {
    const { token, apiKey } = (
      await createKey(adminToken, { name: 'Reader', scopes: ['course:read'] }).expect(201)
    ).body as CreatedKey;

    const me = await http().get('/api/v1/auth/me').set(bearer(token)).expect(200);

    expect(me.body).toMatchObject({
      kind: 'api_key',
      apiKey: { id: apiKey.id, name: 'Reader' },
      tenant: { id: school.tenant.id },
      permissions: ['course:read'],
    });
    const used = await dbs.owner.apiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(used.lastUsedAt).not.toBeNull();
  });

  it('requires apikey:manage to create keys (RBAC)', async () => {
    const instructor = await createTestUser(dbs.owner, school, { role: 'instructor' });
    const { accessToken } = await login(testApp.app, {
      tenant: school.tenant.slug,
      email: instructor.email,
      password: TEST_PASSWORD,
    });

    const response = await createKey(accessToken, { name: 'Nope', scopes: ['course:read'] }).expect(
      403,
    );

    expect(problem(response).code).toBe('PERMISSION_DENIED');
  });

  it('prevents privilege escalation: scopes cannot exceed the creator’s permissions', async () => {
    // A custom role that may manage keys but cannot read the audit log.
    const role = await dbs.owner.role.create({
      data: { tenantId: school.tenant.id, key: 'integrator', name: 'Integrator' },
    });
    await dbs.owner.rolePermission.createMany({
      data: ['apikey:manage', 'course:read'].map((permissionKey) => ({
        tenantId: school.tenant.id,
        roleId: role.id,
        permissionKey,
      })),
    });
    const integrator = await dbs.owner.user.create({
      data: {
        tenantId: school.tenant.id,
        email: 'integrator@keys.test',
        name: 'Integrator',
        passwordHash: (await dbs.owner.user.findUniqueOrThrow({ where: { id: school.admin.id } }))
          .passwordHash,
      },
    });
    await dbs.owner.userRole.create({
      data: { tenantId: school.tenant.id, userId: integrator.id, roleId: role.id },
    });
    const { accessToken } = await login(testApp.app, {
      tenant: school.tenant.slug,
      email: integrator.email,
      password: TEST_PASSWORD,
    });

    const response = await createKey(accessToken, {
      name: 'Sneaky',
      scopes: ['course:read', 'audit:read'],
    }).expect(403);

    expect(problem(response)).toMatchObject({ code: 'SCOPE_NOT_GRANTABLE' });
    expect(problem(response).detail).toContain('audit:read');
    await createKey(accessToken, { name: 'Fine', scopes: ['course:read'] }).expect(201);
  });

  it('never lets a key mint more keys', async () => {
    const refused = await createKey(adminToken, {
      name: 'Minter',
      scopes: ['apikey:manage'],
    }).expect(422);
    expect(problem(refused).code).toBe('SCOPE_NOT_ALLOWED');

    const { token } = (
      await createKey(adminToken, { name: 'Reader', scopes: ['course:read'] }).expect(201)
    ).body as CreatedKey;
    const response = await createKey(token, { name: 'Child', scopes: ['course:read'] }).expect(403);
    expect(problem(response).code).toBe('PERMISSION_DENIED');
  });

  it('stops working the moment it is revoked, and revocation is idempotent', async () => {
    const { token, apiKey } = (
      await createKey(adminToken, { name: 'Temp', scopes: ['course:read'] }).expect(201)
    ).body as CreatedKey;

    await http().delete(`/api/v1/api-keys/${apiKey.id}`).set(bearer(adminToken)).expect(204);
    await http().delete(`/api/v1/api-keys/${apiKey.id}`).set(bearer(adminToken)).expect(204);

    const response = await http().get('/api/v1/auth/me').set(bearer(token)).expect(401);
    expect(problem(response).code).toBe('INVALID_API_KEY');
    await http()
      .delete('/api/v1/api-keys/01a09e9a-0000-7000-8000-000000000000')
      .set(bearer(adminToken))
      .expect(404);
  });

  it('refuses expired keys and keys rewritten to name another school', async () => {
    const { token, apiKey } = (
      await createKey(adminToken, { name: 'Short-lived', scopes: ['course:read'] }).expect(201)
    ).body as CreatedKey;

    await http()
      .get('/api/v1/auth/me')
      .set(bearer(token.replace(school.tenant.id, otherSchool.tenant.id)))
      .expect(401);

    await dbs.owner.apiKey.update({
      where: { id: apiKey.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await http().get('/api/v1/auth/me').set(bearer(token)).expect(401);
  });

  it('audits creation and revocation with the acting user', async () => {
    const { apiKey } = (
      await createKey(adminToken, { name: 'Audited', scopes: ['course:read'] }).expect(201)
    ).body as CreatedKey;
    await http().delete(`/api/v1/api-keys/${apiKey.id}`).set(bearer(adminToken)).expect(204);

    const entries = await dbs.owner.auditLog.findMany({
      where: { tenantId: school.tenant.id, resourceId: apiKey.id },
      orderBy: { id: 'asc' },
    });
    expect(entries.map((entry) => [entry.action, entry.actorType, entry.actorId])).toEqual([
      ['apikey.created', 'user', school.admin.id],
      ['apikey.revoked', 'user', school.admin.id],
    ]);
  });
});
