import request from 'supertest';
import type { App } from '../../../src/app.js';
import type { ProvisionedTenant } from '../../../src/modules/tenants/provisioning.js';
import { bearer, login } from './app.js';
import { createTestTenant, createTestUser, TEST_PASSWORD, type TestDatabases } from './database.js';

export interface Actor {
  id: string;
  email: string;
  token: string;
}

export interface SchoolFixture {
  tenant: ProvisionedTenant;
  id: string;
  slug: string;
  admin: Actor;
  instructor: Actor;
  student: Actor;
}

/** Signs in an existing user of the school and returns their id, email and access token. */
export async function signIn(
  app: App,
  tenant: ProvisionedTenant,
  user: { id: string; email: string },
): Promise<Actor> {
  const session = await login(app, {
    tenant: tenant.tenant.slug,
    email: user.email,
    password: TEST_PASSWORD,
  });
  return { id: user.id, email: user.email, token: session.accessToken };
}

/** A new user with one system role, signed in. */
export async function createActor(
  dbs: TestDatabases,
  app: App,
  tenant: ProvisionedTenant,
  role: 'admin' | 'instructor' | 'student',
): Promise<Actor> {
  const user = await createTestUser(dbs.owner, tenant, { role });
  return signIn(app, tenant, user);
}

/** A freshly provisioned school with a signed-in administrator, instructor and student. */
export async function createSchool(
  dbs: TestDatabases,
  app: App,
  label: string,
): Promise<SchoolFixture> {
  const tenant = await createTestTenant(dbs.owner, label);
  const [admin, instructor, student] = await Promise.all([
    signIn(app, tenant, tenant.admin),
    createActor(dbs, app, tenant, 'instructor'),
    createActor(dbs, app, tenant, 'student'),
  ]);
  return { tenant, id: tenant.tenant.id, slug: tenant.tenant.slug, admin, instructor, student };
}

/** Supertest bound to the app with an access token. */
export function as(app: App, actor: Actor | string) {
  const headers = bearer(typeof actor === 'string' ? actor : actor.token);
  const agent = request(app.server);
  return {
    get: (url: string) => agent.get(url).set(headers),
    post: (url: string) => agent.post(url).set(headers),
    put: (url: string) => agent.put(url).set(headers),
    patch: (url: string) => agent.patch(url).set(headers),
    delete: (url: string) => agent.delete(url).set(headers),
  };
}

export interface CourseResponse {
  id: string;
  code: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  owner: { id: string; name: string };
  sections: SectionResponse[];
}

export interface SectionResponse {
  id: string;
  name: string;
  capacity: number | null;
  enrolledCount: number;
  seatsAvailable: number | null;
  instructor: { id: string; name: string } | null;
}

export interface EnrollmentResponse {
  id: string;
  status: 'pending_payment' | 'active' | 'dropped' | 'completed';
  source: string;
  student: { id: string };
  section: { id: string };
  course: { id: string };
}

/**
 * Through the API: a published course owned by `owner` (an instructor or admin) with one section.
 */
export async function createPublishedCourse(
  app: App,
  owner: Actor,
  options: { capacity?: number | null; priceCents?: number; code?: string } = {},
): Promise<{ course: CourseResponse; section: SectionResponse }> {
  const code = options.code ?? `T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const created = await as(app, owner)
    .post('/api/v1/courses')
    .send({
      code,
      title: `Course ${code}`,
      ...(options.priceCents ? { priceCents: options.priceCents } : {}),
    })
    .expect(201);
  const course = created.body as CourseResponse;
  const section = (
    await as(app, owner)
      .post(`/api/v1/courses/${course.id}/sections`)
      .send({ name: 'Section A', capacity: options.capacity === undefined ? 30 : options.capacity })
      .expect(201)
  ).body as SectionResponse;
  const published = (await as(app, owner).post(`/api/v1/courses/${course.id}/publish`).expect(200))
    .body as CourseResponse;
  return { course: published, section };
}

/** Lets students enroll themselves at the school (off by default). */
export async function enableSelfEnrollment(app: App, admin: Actor): Promise<void> {
  await as(app, admin)
    .patch('/api/v1/tenants/current')
    .send({ features: { selfEnrollment: true } })
    .expect(200);
}
