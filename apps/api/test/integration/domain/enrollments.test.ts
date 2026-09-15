import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../../../src/lib/crypto/hash.js';
import type { ProblemDetails } from '../../../src/lib/errors.js';
import { hashPassword } from '../../../src/lib/password.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import {
  connectTestDatabases,
  createTestUser,
  TEST_PASSWORD,
  type TestDatabases,
} from '../helpers/database.js';
import {
  as,
  createActor,
  createPublishedCourse,
  createSchool,
  enableSelfEnrollment,
  signIn,
  type Actor,
  type EnrollmentResponse,
  type SchoolFixture,
} from '../helpers/school.js';

interface PageBody<T> {
  data: T[];
}

const problem = (response: { body: unknown }) => response.body as ProblemDetails;

describe('enrollments', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: SchoolFixture;
  let passwordHash: string;

  const api = (actor: Actor) => as(testApp.app, actor);
  const enroll = (actor: Actor, body: { sectionId: string; studentId?: string }, key?: string) => {
    const call = api(actor).post('/api/v1/enrollments');
    return (key ? call.set('idempotency-key', key) : call).send(body);
  };
  const setStatus = (actor: Actor, id: string, status: string) =>
    api(actor).patch(`/api/v1/enrollments/${id}`).send({ status });
  const enrolledCount = async (sectionId: string) =>
    (await dbs.owner.section.findUniqueOrThrow({ where: { id: sectionId } })).enrolledCount;

  /** Students share one precomputed hash, so creating many is cheap. */
  async function newStudent(): Promise<Actor> {
    const user = await createTestUser(dbs.owner, school.tenant, { role: 'student', passwordHash });
    return signIn(testApp.app, school.tenant, user);
  }

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    passwordHash = await hashPassword(TEST_PASSWORD);
    school = await createSchool(dbs, testApp.app, 'enroll');
    // Every test below may rely on self-enrollment, so none depends on another having run.
    await enableSelfEnrollment(testApp.app, school.admin);
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  describe('self-enrollment', () => {
    it('is off until the school turns it on', async () => {
      const fresh = await createSchool(dbs, testApp.app, 'enroll-off');
      const { section: closed } = await createPublishedCourse(testApp.app, fresh.instructor);
      const refused = await enroll(fresh.student, { sectionId: closed.id }).expect(403);
      expect(problem(refused).code).toBe('SELF_ENROLLMENT_DISABLED');
      await enableSelfEnrollment(testApp.app, fresh.admin);
      await enroll(fresh.student, { sectionId: closed.id }).expect(201);
    });

    it('enrolls a student in a free published course and shows them the course', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor);
      const response = await enroll(school.student, { sectionId: section.id }).expect(201);
      const enrollment = response.body as EnrollmentResponse;

      expect(enrollment).toMatchObject({
        status: 'active',
        source: 'self',
        student: { id: school.student.id },
      });
      expect(await enrolledCount(section.id)).toBe(1);
      // Enrolling makes the course visible to the student.
      await api(school.student).get(`/api/v1/courses/${enrollment.course.id}`).expect(200);

      const duplicate = await enroll(school.student, { sectionId: section.id }).expect(409);
      expect(problem(duplicate).code).toBe('ALREADY_ENROLLED');
      expect(await enrolledCount(section.id)).toBe(1);
    });

    it('requires checkout for paid courses and hides unpublished ones', async () => {
      const { section: paid } = await createPublishedCourse(testApp.app, school.instructor, {
        priceCents: 4900,
      });
      const payment = await enroll(school.student, { sectionId: paid.id }).expect(409);
      expect(problem(payment).code).toBe('PAYMENT_REQUIRED');

      const { course, section } = await createPublishedCourse(testApp.app, school.instructor);
      await api(school.instructor).post(`/api/v1/courses/${course.id}/archive`).expect(200);
      const hidden = await enroll(school.student, { sectionId: section.id }).expect(404);
      expect(problem(hidden).code).toBe('SECTION_NOT_FOUND');
    });

    it('does not let students enroll someone else', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor);
      const other = await newStudent();
      const response = await enroll(school.student, {
        sectionId: section.id,
        studentId: other.id,
      }).expect(403);
      expect(problem(response).code).toBe('FORBIDDEN');
    });
  });

  describe('enrollment by staff', () => {
    it('lets instructors enroll active students in sections they teach', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor);
      const student = await newStudent();
      const response = await enroll(school.instructor, {
        sectionId: section.id,
        studentId: student.id,
      }).expect(201);
      expect((response.body as EnrollmentResponse).source).toBe('admin');

      const colleague = await createActor(dbs, testApp.app, school.tenant, 'instructor');
      const notTheirs = await enroll(colleague, {
        sectionId: section.id,
        studentId: (await newStudent()).id,
      }).expect(403);
      expect(problem(notTheirs).code).toBe('FORBIDDEN');

      const suspended = await createTestUser(dbs.owner, school.tenant, {
        role: 'student',
        status: 'suspended',
      });
      const inactive = await enroll(school.instructor, {
        sectionId: section.id,
        studentId: suspended.id,
      }).expect(422);
      expect(problem(inactive).code).toBe('INVALID_STUDENT');
    });

    it('refuses enrollment in archived courses', async () => {
      const { course, section } = await createPublishedCourse(testApp.app, school.instructor);
      await api(school.instructor).post(`/api/v1/courses/${course.id}/archive`).expect(200);
      const response = await enroll(school.admin, {
        sectionId: section.id,
        studentId: school.student.id,
      }).expect(409);
      expect(problem(response).code).toBe('COURSE_ARCHIVED');
    });
  });

  describe('status changes', () => {
    it('drops, reinstates and completes, keeping the seat count exact', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor, {
        capacity: 1,
      });
      const student = await newStudent();
      const enrollment = (
        await enroll(school.instructor, { sectionId: section.id, studentId: student.id }).expect(
          201,
        )
      ).body as EnrollmentResponse;
      expect(await enrolledCount(section.id)).toBe(1);

      // The student drops their own enrollment, freeing the seat; repeating it is a no-op.
      await setStatus(student, enrollment.id, 'dropped').expect(200);
      await setStatus(student, enrollment.id, 'dropped').expect(200);
      expect(await enrolledCount(section.id)).toBe(0);

      // Only staff may reinstate, and only into a free seat.
      const selfReinstate = await setStatus(student, enrollment.id, 'active').expect(403);
      expect(problem(selfReinstate).code).toBe('FORBIDDEN');
      const other = await newStudent();
      await enroll(school.instructor, { sectionId: section.id, studentId: other.id }).expect(201);
      const full = await setStatus(school.instructor, enrollment.id, 'active').expect(409);
      expect(problem(full).code).toBe('SECTION_FULL');
      expect(await enrolledCount(section.id)).toBe(1);

      await api(school.instructor)
        .patch(`/api/v1/sections/${section.id}`)
        .send({ capacity: 2 })
        .expect(200);
      await setStatus(school.instructor, enrollment.id, 'active').expect(200);
      const completed = (await setStatus(school.instructor, enrollment.id, 'completed').expect(200))
        .body as {
        status: string;
        completedAt: string | null;
      };
      expect(completed.status).toBe('completed');
      expect(completed.completedAt).not.toBeNull();
      expect(await enrolledCount(section.id)).toBe(2);

      const invalid = await setStatus(school.instructor, enrollment.id, 'dropped').expect(409);
      expect(problem(invalid).code).toBe('INVALID_TRANSITION');

      const trail = await dbs.owner.auditLog.findMany({
        where: {
          tenantId: school.id,
          resourceId: enrollment.id,
          action: 'enrollment.status_changed',
        },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((entry) => entry.metadata)).toEqual([
        { from: 'active', to: 'dropped', studentId: student.id },
        { from: 'dropped', to: 'active', studentId: student.id },
        { from: 'active', to: 'completed', studentId: student.id },
      ]);
    });

    it('reuses the enrollment when a dropped student enrolls again', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor);
      const student = await newStudent();
      const first = (await enroll(student, { sectionId: section.id }).expect(201))
        .body as EnrollmentResponse;
      await setStatus(student, first.id, 'dropped').expect(200);

      const again = (await enroll(student, { sectionId: section.id }).expect(201))
        .body as EnrollmentResponse;
      expect(again.id).toBe(first.id);
      expect(again.status).toBe('active');
      expect(await enrolledCount(section.id)).toBe(1);
    });
  });

  describe('capacity under concurrency', () => {
    it('never overfills a section: of 20 simultaneous requests for 5 seats, exactly 5 succeed', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor, {
        capacity: 5,
      });
      const students = await Promise.all(Array.from({ length: 20 }, () => newStudent()));

      const responses = await Promise.all(
        students.map((student) => enroll(student, { sectionId: section.id })),
      );

      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(5);
      expect(statuses.filter((status) => status === 409)).toHaveLength(15);
      expect(
        responses
          .filter((response) => response.status === 409)
          .every((response) => problem(response).code === 'SECTION_FULL'),
      ).toBe(true);
      expect(await enrolledCount(section.id)).toBe(5);
      expect(await dbs.owner.enrollment.count({ where: { sectionId: section.id } })).toBe(5);
    });

    it('counts a double-submitted enrollment once', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor);
      const student = await newStudent();

      const responses = await Promise.all([
        enroll(student, { sectionId: section.id }),
        enroll(student, { sectionId: section.id }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(await enrolledCount(section.id)).toBe(1);
    });
  });

  describe('with an Idempotency-Key', () => {
    it('replays the first outcome, success or failure', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor, {
        capacity: 1,
      });
      const student = await newStudent();
      const key = randomUUID();

      const first = await enroll(student, { sectionId: section.id }, key).expect(201);
      const retry = await enroll(student, { sectionId: section.id }, key).expect(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(await enrolledCount(section.id)).toBe(1);

      // A 409 is a final answer too: retrying with the same key does not try again.
      const late = await newStudent();
      const lateKey = randomUUID();
      await enroll(late, { sectionId: section.id }, lateKey).expect(409);
      await api(school.instructor)
        .patch(`/api/v1/sections/${section.id}`)
        .send({ capacity: 2 })
        .expect(200);
      const replayed = await enroll(late, { sectionId: section.id }, lateKey).expect(409);
      expect(replayed.headers['idempotent-replayed']).toBe('true');
      expect(problem(replayed).code).toBe('SECTION_FULL');
    });

    it('answers 409 while the original request is still running, and recovers abandoned claims', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor);
      const student = await newStudent();
      const key = randomUUID();
      const body = { sectionId: section.id };
      // What the plugin writes when a request starts: a claim without a stored response.
      const claim = await dbs.owner.idempotencyKey.create({
        data: {
          tenantId: school.id,
          principalId: student.id,
          key,
          method: 'POST',
          path: '/api/v1/enrollments',
          requestHash: sha256(`POST /api/v1/enrollments ${canonicalJson(body)}`),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const busy = await enroll(student, body, key).expect(409);
      expect(problem(busy).code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
      expect(busy.headers['retry-after']).toBe('1');

      // The process that made the claim died: after a minute the key can be taken over.
      await dbs.owner.idempotencyKey.update({
        where: { id: claim.id },
        data: { createdAt: new Date(Date.now() - 120_000) },
      });
      await enroll(student, body, key).expect(201);
      const stored = await dbs.owner.idempotencyKey.findUniqueOrThrow({ where: { id: claim.id } });
      expect(stored.statusCode).toBe(201);
    });
  });

  describe('visibility', () => {
    it('shows students their own enrollments and instructors their sections’ rosters', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor);
      const [alice, bob] = await Promise.all([newStudent(), newStudent()]);
      const aliceEnrollment = (await enroll(alice, { sectionId: section.id }).expect(201))
        .body as EnrollmentResponse;
      await enroll(bob, { sectionId: section.id }).expect(201);

      const own = (await api(alice).get('/api/v1/enrollments?limit=100').expect(200))
        .body as PageBody<EnrollmentResponse>;
      expect(own.data.map((entry) => entry.student.id)).toEqual([alice.id]);

      const roster = (
        await api(school.instructor).get(`/api/v1/enrollments?sectionId=${section.id}`).expect(200)
      ).body as PageBody<EnrollmentResponse>;
      expect(roster.data.map((entry) => entry.student.id).sort()).toEqual(
        [alice.id, bob.id].sort(),
      );

      await api(bob).get(`/api/v1/enrollments/${aliceEnrollment.id}`).expect(404);
      const colleague = await createActor(dbs, testApp.app, school.tenant, 'instructor');
      await api(colleague).get(`/api/v1/enrollments/${aliceEnrollment.id}`).expect(404);
      const empty = (
        await api(colleague).get(`/api/v1/enrollments?sectionId=${section.id}`).expect(200)
      ).body as PageBody<EnrollmentResponse>;
      expect(empty.data).toEqual([]);
    });
  });
});
