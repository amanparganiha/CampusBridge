import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProblemDetails } from '../../../src/lib/errors.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { connectTestDatabases, type TestDatabases } from '../helpers/database.js';
import {
  as,
  createActor,
  createPublishedCourse,
  createSchool,
  type Actor,
  type EnrollmentResponse,
  type SchoolFixture,
} from '../helpers/school.js';

interface GradeBody {
  id: string;
  enrollmentId: string;
  title: string;
  score: number;
  maxScore: number;
  feedback: string | null;
  gradedById: string | null;
}
interface GradebookBody {
  data: GradeBody[];
  summary: { count: number; totalScore: number; totalMaxScore: number; percentage: number | null };
}

const problem = (response: { body: unknown }) => response.body as ProblemDetails;

describe('grades', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: SchoolFixture;
  let enrollment: EnrollmentResponse;

  const api = (actor: Actor) => as(testApp.app, actor);
  const record = (actor: Actor, enrollmentId: string, body: Record<string, unknown>) =>
    api(actor).post(`/api/v1/enrollments/${enrollmentId}/grades`).send(body);

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    school = await createSchool(dbs, testApp.app, 'grades');
    const { section } = await createPublishedCourse(testApp.app, school.instructor);
    enrollment = (
      await api(school.instructor)
        .post('/api/v1/enrollments')
        .send({ sectionId: section.id, studentId: school.student.id })
        .expect(201)
    ).body as EnrollmentResponse;
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  it('records grades with exact decimal totals', async () => {
    for (const [title, score] of [
      ['Quiz 1', 0.1],
      ['Quiz 2', 0.2],
    ] as const) {
      const response = await record(school.instructor, enrollment.id, {
        title,
        score,
        maxScore: 1,
      }).expect(201);
      expect(response.body).toMatchObject({
        title,
        score,
        maxScore: 1,
        gradedById: school.instructor.id,
      });
    }

    const gradebook = (
      await api(school.student).get(`/api/v1/enrollments/${enrollment.id}/grades`).expect(200)
    ).body as GradebookBody;
    expect(gradebook.data.map((grade) => grade.title)).toEqual(['Quiz 1', 'Quiz 2']);
    // 0.1 + 0.2 is 0.3 here, not 0.30000000000000004.
    expect(gradebook.summary).toEqual({
      count: 2,
      totalScore: 0.3,
      totalMaxScore: 2,
      percentage: 15,
    });

    const events = await dbs.owner.outboxEvent.findMany({
      where: { tenantId: school.id, type: 'grade.recorded' },
    });
    expect(events).toHaveLength(2);
  });

  it('validates scores', async () => {
    await record(school.instructor, enrollment.id, {
      title: 'Too high',
      score: 11,
      maxScore: 10,
    }).expect(400);
    await record(school.instructor, enrollment.id, {
      title: 'Precise',
      score: 1.005,
      maxScore: 10,
    }).expect(400);
    await record(school.instructor, enrollment.id, {
      title: 'Negative',
      score: -1,
      maxScore: 10,
    }).expect(400);
    await record(school.instructor, enrollment.id, {
      title: 'No max',
      score: 0,
      maxScore: 0,
    }).expect(400);
  });

  it('corrects and deletes grades, auditing both with the before and after', async () => {
    const grade = (
      await record(school.instructor, enrollment.id, {
        title: 'Essay',
        score: 7,
        maxScore: 10,
      }).expect(201)
    ).body as GradeBody;

    const corrected = await api(school.instructor)
      .patch(`/api/v1/grades/${grade.id}`)
      .send({ score: 8.5, feedback: 'Regraded after review.' })
      .expect(200);
    expect(corrected.body).toMatchObject({
      score: 8.5,
      maxScore: 10,
      feedback: 'Regraded after review.',
    });

    const overMax = await api(school.instructor)
      .patch(`/api/v1/grades/${grade.id}`)
      .send({ maxScore: 5 })
      .expect(422);
    expect(problem(overMax).code).toBe('INVALID_SCORE');

    await api(school.instructor).delete(`/api/v1/grades/${grade.id}`).expect(204);
    await api(school.instructor).delete(`/api/v1/grades/${grade.id}`).expect(404);

    const trail = await dbs.owner.auditLog.findMany({
      where: { tenantId: school.id, resourceId: grade.id },
      orderBy: { id: 'asc' },
    });
    expect(trail.map((entry) => entry.action)).toEqual([
      'grade.recorded',
      'grade.updated',
      'grade.deleted',
    ]);
    expect(trail[1]?.metadata).toMatchObject({
      before: { score: 7, maxScore: 10 },
      after: { score: 8.5, maxScore: 10 },
    });
  });

  it('lets only staff who teach the section grade it', async () => {
    const studentAttempt = await record(school.student, enrollment.id, {
      title: 'Self-graded',
      score: 10,
      maxScore: 10,
    }).expect(403);
    expect(problem(studentAttempt).code).toBe('PERMISSION_DENIED');

    // A colleague cannot even see the enrollment.
    const colleague = await createActor(dbs, testApp.app, school.tenant, 'instructor');
    await record(colleague, enrollment.id, { title: 'Drive-by', score: 1, maxScore: 10 }).expect(
      404,
    );
    await api(colleague).get(`/api/v1/enrollments/${enrollment.id}/grades`).expect(404);

    // Administrators can.
    await record(school.admin, enrollment.id, {
      title: 'Moderated',
      score: 5,
      maxScore: 10,
    }).expect(201);
  });

  it('keeps grades private to the student and their teachers', async () => {
    const grade = (
      await record(school.instructor, enrollment.id, {
        title: 'Private',
        score: 6,
        maxScore: 10,
      }).expect(201)
    ).body as GradeBody;
    const classmate = await createActor(dbs, testApp.app, school.tenant, 'student');
    await api(classmate).get(`/api/v1/enrollments/${enrollment.id}/grades`).expect(404);
    await api(classmate).patch(`/api/v1/grades/${grade.id}`).send({ score: 0 }).expect(403);
  });

  it('refuses new grades once a student has dropped', async () => {
    const { section } = await createPublishedCourse(testApp.app, school.instructor);
    const student = await createActor(dbs, testApp.app, school.tenant, 'student');
    const dropped = (
      await api(school.instructor)
        .post('/api/v1/enrollments')
        .send({ sectionId: section.id, studentId: student.id })
        .expect(201)
    ).body as EnrollmentResponse;
    await api(student)
      .patch(`/api/v1/enrollments/${dropped.id}`)
      .send({ status: 'dropped' })
      .expect(200);

    const response = await record(school.instructor, dropped.id, {
      title: 'Late',
      score: 1,
      maxScore: 1,
    }).expect(409);
    expect(problem(response).code).toBe('ENROLLMENT_NOT_GRADABLE');
  });
});
