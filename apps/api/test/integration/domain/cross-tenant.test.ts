import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProblemDetails } from '../../../src/lib/errors.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { connectTestDatabases, type TestDatabases } from '../helpers/database.js';
import {
  as,
  createPublishedCourse,
  createSchool,
  type Actor,
  type CourseResponse,
  type EnrollmentResponse,
  type SchoolFixture,
  type SectionResponse,
} from '../helpers/school.js';

interface OpenApiDocument {
  paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
}

/** Everything school A owns that has an id someone could put in a URL. */
interface Victim {
  userId: string;
  courseId: string;
  sectionId: string;
  enrollmentId: string;
  gradeId: string;
  invitationId: string;
  apiKeyId: string;
}

interface Attack {
  operation: string;
  id: (victim: Victim) => string;
  body?: Record<string, unknown>;
}

/**
 * Every route that takes an id, aimed at another school's record. The meta-test below fails when
 * a new route with a path parameter is added without an entry here.
 */
const ATTACKS: Attack[] = [
  { operation: 'GET /api/v1/users/{id}', id: (v) => v.userId },
  { operation: 'PATCH /api/v1/users/{id}', id: (v) => v.userId, body: { name: 'Hijacked' } },
  { operation: 'PUT /api/v1/users/{id}/roles', id: (v) => v.userId, body: { roles: ['admin'] } },
  { operation: 'DELETE /api/v1/invitations/{id}', id: (v) => v.invitationId },
  { operation: 'DELETE /api/v1/api-keys/{id}', id: (v) => v.apiKeyId },
  { operation: 'GET /api/v1/courses/{id}', id: (v) => v.courseId },
  { operation: 'PATCH /api/v1/courses/{id}', id: (v) => v.courseId, body: { title: 'Hijacked' } },
  { operation: 'POST /api/v1/courses/{id}/publish', id: (v) => v.courseId },
  { operation: 'POST /api/v1/courses/{id}/archive', id: (v) => v.courseId },
  { operation: 'DELETE /api/v1/courses/{id}', id: (v) => v.courseId },
  {
    operation: 'POST /api/v1/courses/{id}/sections',
    id: (v) => v.courseId,
    body: { name: 'Hijacked' },
  },
  { operation: 'PATCH /api/v1/sections/{id}', id: (v) => v.sectionId, body: { name: 'Hijacked' } },
  { operation: 'DELETE /api/v1/sections/{id}', id: (v) => v.sectionId },
  { operation: 'GET /api/v1/enrollments/{id}', id: (v) => v.enrollmentId },
  {
    operation: 'PATCH /api/v1/enrollments/{id}',
    id: (v) => v.enrollmentId,
    body: { status: 'dropped' },
  },
  { operation: 'GET /api/v1/enrollments/{id}/grades', id: (v) => v.enrollmentId },
  {
    operation: 'POST /api/v1/enrollments/{id}/grades',
    id: (v) => v.enrollmentId,
    body: { title: 'Hijacked', score: 0, maxScore: 1 },
  },
  { operation: 'PATCH /api/v1/grades/{id}', id: (v) => v.gradeId, body: { title: 'Hijacked' } },
  { operation: 'DELETE /api/v1/grades/{id}', id: (v) => v.gradeId },
];

describe('cross-tenant isolation through the API', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let schoolA: SchoolFixture;
  let schoolB: SchoolFixture;
  let victim: Victim;
  let courseB: CourseResponse;
  let sectionB: SectionResponse;

  const api = (actor: Actor | string) => as(testApp.app, actor);

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    [schoolA, schoolB] = await Promise.all([
      createSchool(dbs, testApp.app, 'tenant-a'),
      createSchool(dbs, testApp.app, 'tenant-b'),
    ]);

    // School A: a course with a section, an enrolled student with a grade, an invitation, a key.
    const { course, section } = await createPublishedCourse(testApp.app, schoolA.instructor);
    const enrollment = (
      await api(schoolA.instructor)
        .post('/api/v1/enrollments')
        .send({ sectionId: section.id, studentId: schoolA.student.id })
        .expect(201)
    ).body as EnrollmentResponse;
    const grade = (
      await api(schoolA.instructor)
        .post(`/api/v1/enrollments/${enrollment.id}/grades`)
        .send({ title: 'Midterm', score: 9, maxScore: 10 })
        .expect(201)
    ).body as { id: string };
    const invitation = (
      await api(schoolA.admin)
        .post('/api/v1/users/invite')
        .send({ email: 'pending@a.test', role: 'student' })
        .expect(201)
    ).body as { id: string };
    const apiKey = (
      await api(schoolA.admin)
        .post('/api/v1/api-keys')
        .send({ name: 'SIS', scopes: ['course:read'] })
        .expect(201)
    ).body as { apiKey: { id: string } };

    victim = {
      userId: schoolA.student.id,
      courseId: course.id,
      sectionId: section.id,
      enrollmentId: enrollment.id,
      gradeId: grade.id,
      invitationId: invitation.id,
      apiKeyId: apiKey.apiKey.id,
    };
    ({ course: courseB, section: sectionB } = await createPublishedCourse(
      testApp.app,
      schoolB.instructor,
    ));
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  it('covers every authenticated route that takes a path parameter', async () => {
    const document = (await request(testApp.app.server).get('/docs/json').expect(200))
      .body as OpenApiDocument;
    const parameterised = Object.entries(document.paths)
      .filter(([path]) => path.startsWith('/api/v1') && path.includes('{'))
      .flatMap(([path, methods]) =>
        Object.entries(methods)
          .filter(([, operation]) => operation.security?.length !== 0)
          .map(([method]) => `${method.toUpperCase()} ${path}`),
      );

    expect(new Set(ATTACKS.map((attack) => attack.operation))).toEqual(new Set(parameterised));
  });

  it.each(ATTACKS)(
    "$operation with another school's id answers 404",
    async ({ operation, id, body }) => {
      const [method, template] = operation.split(' ') as [string, string];
      const url = template.replace('{id}', id(victim));
      const call = api(schoolB.admin)[
        method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'
      ](url);
      const response = await (body ? call.send(body) : call);

      expect(`${operation} -> ${String(response.status)}`).toBe(`${operation} -> 404`);
    },
  );

  it("left school A's records untouched", async () => {
    const [user, course, section, enrollment, grade, invitation, apiKey] = await Promise.all([
      dbs.owner.user.findUniqueOrThrow({
        where: { id: victim.userId },
        include: { userRoles: { include: { role: true } } },
      }),
      dbs.owner.course.findUniqueOrThrow({ where: { id: victim.courseId } }),
      dbs.owner.section.findUniqueOrThrow({ where: { id: victim.sectionId } }),
      dbs.owner.enrollment.findUniqueOrThrow({ where: { id: victim.enrollmentId } }),
      dbs.owner.grade.findUniqueOrThrow({ where: { id: victim.gradeId } }),
      dbs.owner.invitation.findUniqueOrThrow({ where: { id: victim.invitationId } }),
      dbs.owner.apiKey.findUniqueOrThrow({ where: { id: victim.apiKeyId } }),
    ]);

    expect(user.status).toBe('active');
    expect(user.name).not.toBe('Hijacked');
    expect(user.userRoles.map((grant) => grant.role.key)).toEqual(['student']);
    expect(course).toMatchObject({ status: 'published' });
    expect(course.title).not.toBe('Hijacked');
    expect(section.name).toBe('Section A');
    expect(enrollment.status).toBe('active');
    expect(grade.title).toBe('Midterm');
    expect(invitation.revokedAt).toBeNull();
    expect(apiKey.revokedAt).toBeNull();
    expect(await dbs.owner.section.count({ where: { courseId: victim.courseId } })).toBe(1);
    expect(await dbs.owner.grade.count({ where: { enrollmentId: victim.enrollmentId } })).toBe(1);
    // School B's administrator left no trace in school A.
    expect(
      await dbs.owner.auditLog.count({
        where: { tenantId: schoolA.id, actorId: schoolB.admin.id },
      }),
    ).toBe(0);
  });

  it("rejects references to another school's records inside request bodies", async () => {
    const owner = await api(schoolB.admin)
      .post('/api/v1/courses')
      .send({ code: 'XT-1', title: 'Borrowed teacher', ownerId: schoolA.instructor.id })
      .expect(422);
    expect((owner.body as ProblemDetails).code).toBe('INVALID_OWNER');

    const transfer = await api(schoolB.admin)
      .patch(`/api/v1/courses/${courseB.id}`)
      .send({ ownerId: schoolA.instructor.id })
      .expect(422);
    expect((transfer.body as ProblemDetails).code).toBe('INVALID_OWNER');

    const instructor = await api(schoolB.admin)
      .patch(`/api/v1/sections/${sectionB.id}`)
      .send({ instructorId: schoolA.instructor.id })
      .expect(422);
    expect((instructor.body as ProblemDetails).code).toBe('INVALID_INSTRUCTOR');

    const foreignSection = await api(schoolB.admin)
      .post('/api/v1/enrollments')
      .send({ sectionId: victim.sectionId, studentId: schoolB.student.id })
      .expect(404);
    expect((foreignSection.body as ProblemDetails).code).toBe('SECTION_NOT_FOUND');

    const foreignStudent = await api(schoolB.admin)
      .post('/api/v1/enrollments')
      .send({ sectionId: sectionB.id, studentId: schoolA.student.id })
      .expect(422);
    expect((foreignStudent.body as ProblemDetails).code).toBe('INVALID_STUDENT');
  });

  it("never lists another school's records", async () => {
    const victimIds = Object.values(victim) as string[];
    for (const path of [
      '/api/v1/users?limit=100',
      '/api/v1/courses?limit=100',
      '/api/v1/catalog?limit=100',
      '/api/v1/enrollments?limit=100',
      '/api/v1/invitations',
      '/api/v1/api-keys',
      '/api/v1/audit-logs?limit=100',
    ]) {
      const body = JSON.stringify((await api(schoolB.admin).get(path).expect(200)).body);
      expect(
        victimIds.filter((id) => body.includes(id)),
        path,
      ).toEqual([]);
      expect(body.includes(schoolA.id), path).toBe(false);
    }
  });

  it('refuses to switch schools with a header, even for an API key', async () => {
    const mismatch = await api(schoolB.admin)
      .get('/api/v1/courses')
      .set('x-tenant-id', schoolA.id)
      .expect(403);
    expect((mismatch.body as ProblemDetails).code).toBe('TENANT_MISMATCH');

    const key = (
      await api(schoolB.admin)
        .post('/api/v1/api-keys')
        .send({ name: 'Reader', scopes: ['course:read', 'enrollment:read', 'grade:read'] })
        .expect(201)
    ).body as { token: string };
    await api(key.token).get(`/api/v1/courses/${victim.courseId}`).expect(404);
    await api(key.token).get(`/api/v1/enrollments/${victim.enrollmentId}/grades`).expect(404);
    await api(key.token).get('/api/v1/courses').set('x-tenant-id', schoolA.id).expect(403);
  });
});
