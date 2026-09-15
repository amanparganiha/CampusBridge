import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProblemDetails } from '../../../src/lib/errors.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { connectTestDatabases, type TestDatabases } from '../helpers/database.js';
import { as, createSchool, type SchoolFixture } from '../helpers/school.js';

interface TenantBody {
  id: string;
  slug: string;
  name: string;
  settings: {
    branding: { displayName?: string; primaryColor?: string; logoUrl?: string };
    features: { selfEnrollment: boolean; payments: boolean; ai: boolean };
  };
}

describe('the school profile', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: SchoolFixture;

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    school = await createSchool(dbs, testApp.app, 'profile');
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  it('shows every member their school, with safe defaults for features', async () => {
    const response = await as(testApp.app, school.student)
      .get('/api/v1/tenants/current')
      .expect(200);

    expect(response.body).toMatchObject({
      id: school.id,
      slug: school.slug,
      settings: { branding: {}, features: { selfEnrollment: false, payments: false, ai: false } },
    });
  });

  it('lets administrators update branding and features, merging rather than replacing', async () => {
    const admin = as(testApp.app, school.admin);
    await admin
      .patch('/api/v1/tenants/current')
      .send({ branding: { displayName: 'Profile High', primaryColor: '#1d4ed8' } })
      .expect(200);
    const response = await admin
      .patch('/api/v1/tenants/current')
      .send({ name: 'Profile High School', features: { selfEnrollment: true } })
      .expect(200);

    const body = response.body as TenantBody;
    expect(body.name).toBe('Profile High School');
    expect(body.settings).toEqual({
      branding: { displayName: 'Profile High', primaryColor: '#1d4ed8' },
      features: { selfEnrollment: true, payments: false, ai: false },
    });

    const audited = await dbs.owner.auditLog.findMany({
      where: { tenantId: school.id, action: 'tenant.updated' },
      orderBy: { id: 'asc' },
    });
    expect(audited.map((entry) => entry.metadata)).toEqual([
      { changed: ['branding'] },
      { changed: ['name', 'features'], features: { selfEnrollment: true } },
    ]);
  });

  it('validates branding: hex colours and https logos only', async () => {
    const admin = as(testApp.app, school.admin);
    const badColour = await admin
      .patch('/api/v1/tenants/current')
      .send({ branding: { primaryColor: 'red' } })
      .expect(400);
    expect((badColour.body as ProblemDetails).code).toBe('VALIDATION_FAILED');
    await admin
      .patch('/api/v1/tenants/current')
      .send({ branding: { logoUrl: 'http://cdn.example.test/logo.png' } })
      .expect(400);
    await admin.patch('/api/v1/tenants/current').send({}).expect(400);
  });

  it('is read-only for instructors and students', async () => {
    const response = await as(testApp.app, school.instructor)
      .patch('/api/v1/tenants/current')
      .send({ name: 'Taken over' })
      .expect(403);
    expect((response.body as ProblemDetails).code).toBe('PERMISSION_DENIED');
  });

  it('publishes a login-page profile by slug without credentials, and nothing more', async () => {
    const branded = await createSchool(dbs, testApp.app, 'branded');
    await as(testApp.app, branded.admin)
      .patch('/api/v1/tenants/current')
      .send({
        name: 'Branded Academy',
        branding: { displayName: 'Branded', primaryColor: '#0f766e' },
        features: { ai: true },
      })
      .expect(200);

    const response = await request(testApp.app.server)
      .get(`/api/v1/tenants/by-slug/${branded.slug}`)
      .expect(200);

    expect(response.body).toEqual({
      id: branded.id,
      slug: branded.slug,
      name: 'Branded Academy',
      branding: { displayName: 'Branded', primaryColor: '#0f766e' },
      sso: { enabled: false, displayName: null },
    });
    expect(JSON.stringify(response.body)).not.toContain('features');
  });

  it('answers 404 for unknown and suspended schools alike', async () => {
    await request(testApp.app.server).get('/api/v1/tenants/by-slug/no-such-school').expect(404);

    const suspended = await createSchool(dbs, testApp.app, 'suspended');
    await dbs.owner.tenant.update({ where: { id: suspended.id }, data: { status: 'suspended' } });
    await request(testApp.app.server).get(`/api/v1/tenants/by-slug/${suspended.slug}`).expect(404);
  });
});
