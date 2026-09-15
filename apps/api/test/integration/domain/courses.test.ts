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
  type CourseResponse,
  type SchoolFixture,
  type SectionResponse,
} from '../helpers/school.js';

interface PageBody<T> {
  data: T[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}
interface CatalogCourse {
  id: string;
  code: string;
  sections: { id: string; seatsAvailable: number | null; enrolledCount?: number }[];
}

const problem = (response: { body: unknown }) => response.body as ProblemDetails;

describe('courses and sections', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: SchoolFixture;
  let colleague: Actor;

  const api = (actor: Actor) => as(testApp.app, actor);
  const uniqueCode = () => `CRS-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    school = await createSchool(dbs, testApp.app, 'courses');
    colleague = await createActor(dbs, testApp.app, school.tenant, 'instructor');
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  describe('creating', () => {
    it('creates a draft owned by the instructor, normalising the catalog code', async () => {
      const response = await api(school.instructor)
        .post('/api/v1/courses')
        .send({ code: ' bio 101 ', title: 'Biology', priceCents: 0, currency: 'EUR' })
        .expect(201);

      expect(response.body).toMatchObject({
        code: 'BIO-101',
        title: 'Biology',
        status: 'draft',
        currency: 'eur',
        owner: { id: school.instructor.id },
        sections: [],
      });
      const events = await dbs.owner.outboxEvent.count({
        where: {
          tenantId: school.id,
          type: 'course.created',
          aggregateId: (response.body as CourseResponse).id,
        },
      });
      expect(events).toBe(1);
    });

    it('keeps codes unique per school', async () => {
      await api(school.instructor)
        .post('/api/v1/courses')
        .send({ code: 'CHEM-1', title: 'Chemistry' })
        .expect(201);
      const duplicate = await api(colleague)
        .post('/api/v1/courses')
        .send({ code: 'chem-1', title: 'Also chemistry' })
        .expect(409);
      expect(problem(duplicate).code).toBe('COURSE_CODE_TAKEN');

      // Another school may use the same code.
      const other = await createSchool(dbs, testApp.app, 'courses-other');
      await as(testApp.app, other.instructor)
        .post('/api/v1/courses')
        .send({ code: 'CHEM-1', title: 'Chemistry elsewhere' })
        .expect(201);
    });

    it('lets only administrators create a course for someone else, and only for staff', async () => {
      const denied = await api(school.instructor)
        .post('/api/v1/courses')
        .send({ code: uniqueCode(), title: 'For a colleague', ownerId: colleague.id })
        .expect(403);
      expect(problem(denied).code).toBe('CANNOT_ASSIGN_OWNER');

      const assigned = await api(school.admin)
        .post('/api/v1/courses')
        .send({ code: uniqueCode(), title: 'Assigned', ownerId: colleague.id })
        .expect(201);
      expect((assigned.body as CourseResponse).owner.id).toBe(colleague.id);

      const toStudent = await api(school.admin)
        .post('/api/v1/courses')
        .send({ code: uniqueCode(), title: 'Taught by a student?', ownerId: school.student.id })
        .expect(422);
      expect(problem(toStudent).code).toBe('INVALID_OWNER');
    });

    it('is not available to students', async () => {
      const response = await api(school.student)
        .post('/api/v1/courses')
        .send({ code: uniqueCode(), title: 'Nope' })
        .expect(403);
      expect(problem(response).code).toBe('PERMISSION_DENIED');
    });
  });

  describe('visibility', () => {
    let mine: CourseResponse;
    let theirs: CourseResponse;

    beforeAll(async () => {
      ({ course: mine } = await createPublishedCourse(testApp.app, school.instructor));
      ({ course: theirs } = await createPublishedCourse(testApp.app, colleague));
    });

    it('shows instructors their own courses, and administrators every course', async () => {
      const own = (await api(school.instructor).get('/api/v1/courses?limit=100').expect(200))
        .body as PageBody<CourseResponse>;
      expect(own.data.map((course) => course.id)).toContain(mine.id);
      expect(own.data.map((course) => course.id)).not.toContain(theirs.id);

      const all = (await api(school.admin).get('/api/v1/courses?limit=100').expect(200))
        .body as PageBody<CourseResponse>;
      expect(all.data.map((course) => course.id)).toEqual(
        expect.arrayContaining([mine.id, theirs.id]),
      );
    });

    it('answers 404, not 403, for a course you cannot see', async () => {
      await api(school.instructor).get(`/api/v1/courses/${theirs.id}`).expect(404);
      await api(school.student).get(`/api/v1/courses/${mine.id}`).expect(404);
    });

    it('answers 403 when you can see a course but not change it', async () => {
      const section = (
        await api(school.admin)
          .post(`/api/v1/courses/${theirs.id}/sections`)
          .send({ name: 'Co-taught', instructorId: school.instructor.id })
          .expect(201)
      ).body as SectionResponse;
      expect(section.instructor?.id).toBe(school.instructor.id);

      // The section instructor can now see the course, but only its owner may edit it.
      await api(school.instructor).get(`/api/v1/courses/${theirs.id}`).expect(200);
      const response = await api(school.instructor)
        .patch(`/api/v1/courses/${theirs.id}`)
        .send({ title: 'Mine now' })
        .expect(403);
      expect(problem(response).code).toBe('FORBIDDEN');
    });

    it('lists published courses and open seats in the catalog', async () => {
      const draft = (
        await api(school.instructor)
          .post('/api/v1/courses')
          .send({ code: uniqueCode(), title: 'Draft' })
          .expect(201)
      ).body as CourseResponse;

      const catalog = (await api(school.student).get('/api/v1/catalog?limit=100').expect(200))
        .body as PageBody<CatalogCourse>;
      const ids = catalog.data.map((course) => course.id);
      expect(ids).toEqual(expect.arrayContaining([mine.id, theirs.id]));
      expect(ids).not.toContain(draft.id);
      const listed = catalog.data.find((course) => course.id === mine.id);
      expect(listed?.sections[0]).toMatchObject({ seatsAvailable: 30 });
      expect(listed?.sections[0]).not.toHaveProperty('enrolledCount');
    });
  });

  describe('lifecycle', () => {
    it('publishes and archives, auditing each change once', async () => {
      const course = (
        await api(school.instructor)
          .post('/api/v1/courses')
          .send({ code: uniqueCode(), title: 'Lifecycle' })
          .expect(201)
      ).body as CourseResponse;

      await api(school.instructor).post(`/api/v1/courses/${course.id}/publish`).expect(200);
      await api(school.instructor).post(`/api/v1/courses/${course.id}/publish`).expect(200);
      const archived = await api(school.instructor)
        .post(`/api/v1/courses/${course.id}/archive`)
        .expect(200);
      expect((archived.body as CourseResponse).status).toBe('archived');

      const trail = await dbs.owner.auditLog.findMany({
        where: { tenantId: school.id, resourceId: course.id },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((entry) => entry.action)).toEqual([
        'course.created',
        'course.published',
        'course.archived',
      ]);
    });

    it('updates only what changed, and lets administrators transfer ownership', async () => {
      const { course } = await createPublishedCourse(testApp.app, school.instructor);
      const updated = await api(school.instructor)
        .patch(`/api/v1/courses/${course.id}`)
        .send({ title: 'Renamed', code: course.code })
        .expect(200);
      expect((updated.body as CourseResponse).title).toBe('Renamed');
      const audit = await dbs.owner.auditLog.findFirstOrThrow({
        where: { tenantId: school.id, resourceId: course.id, action: 'course.updated' },
      });
      expect(audit.metadata).toEqual({ changed: ['title'] });

      const denied = await api(school.instructor)
        .patch(`/api/v1/courses/${course.id}`)
        .send({ ownerId: colleague.id })
        .expect(403);
      expect(problem(denied).code).toBe('CANNOT_ASSIGN_OWNER');
      const transferred = await api(school.admin)
        .patch(`/api/v1/courses/${course.id}`)
        .send({ ownerId: colleague.id })
        .expect(200);
      expect((transferred.body as CourseResponse).owner.id).toBe(colleague.id);
    });

    it('deletes courses nobody enrolled in; others must be archived', async () => {
      const empty = (
        await api(school.instructor)
          .post('/api/v1/courses')
          .send({ code: uniqueCode(), title: 'Empty' })
          .expect(201)
      ).body as CourseResponse;
      await api(school.instructor).delete(`/api/v1/courses/${empty.id}`).expect(204);
      await api(school.instructor).get(`/api/v1/courses/${empty.id}`).expect(404);

      const { course, section } = await createPublishedCourse(testApp.app, school.instructor);
      await api(school.instructor)
        .post('/api/v1/enrollments')
        .send({ sectionId: section.id, studentId: school.student.id })
        .expect(201);
      const refused = await api(school.instructor)
        .delete(`/api/v1/courses/${course.id}`)
        .expect(409);
      expect(problem(refused).code).toBe('COURSE_HAS_ENROLLMENTS');
      const sectionRefused = await api(school.instructor)
        .delete(`/api/v1/sections/${section.id}`)
        .expect(409);
      expect(problem(sectionRefused).code).toBe('SECTION_HAS_ENROLLMENTS');
    });
  });

  describe('sections', () => {
    it('never lowers capacity below the students already enrolled', async () => {
      const { section } = await createPublishedCourse(testApp.app, school.instructor, {
        capacity: 3,
      });
      const students = await Promise.all([
        createActor(dbs, testApp.app, school.tenant, 'student'),
        createActor(dbs, testApp.app, school.tenant, 'student'),
      ]);
      for (const student of students) {
        await api(school.instructor)
          .post('/api/v1/enrollments')
          .send({ sectionId: section.id, studentId: student.id })
          .expect(201);
      }

      const refused = await api(school.instructor)
        .patch(`/api/v1/sections/${section.id}`)
        .send({ capacity: 1 })
        .expect(409);
      expect(problem(refused).code).toBe('CAPACITY_BELOW_ENROLLMENT');

      const lowered = await api(school.instructor)
        .patch(`/api/v1/sections/${section.id}`)
        .send({ capacity: 2 })
        .expect(200);
      expect(lowered.body).toMatchObject({ capacity: 2, enrolledCount: 2, seatsAvailable: 0 });
    });

    it('validates schedules and instructors', async () => {
      const { course, section } = await createPublishedCourse(testApp.app, school.instructor);
      await api(school.instructor)
        .post(`/api/v1/courses/${course.id}/sections`)
        .send({
          name: 'Backwards',
          startsAt: '2026-10-02T09:00:00Z',
          endsAt: '2026-10-01T09:00:00Z',
        })
        .expect(400);
      const schedule = await api(school.instructor)
        .patch(`/api/v1/sections/${section.id}`)
        .send({ startsAt: '2027-01-01T00:00:00Z', endsAt: '2026-01-01T00:00:00Z' })
        .expect(422);
      expect(problem(schedule).code).toBe('INVALID_SCHEDULE');

      const instructor = await api(school.instructor)
        .patch(`/api/v1/sections/${section.id}`)
        .send({ instructorId: school.student.id })
        .expect(422);
      expect(problem(instructor).code).toBe('INVALID_INSTRUCTOR');
    });

    it('lets only the course owner (or an administrator) manage its sections', async () => {
      const { section } = await createPublishedCourse(testApp.app, colleague);
      await api(school.instructor)
        .patch(`/api/v1/sections/${section.id}`)
        .send({ name: 'Hijacked' })
        .expect(404);
      await api(school.admin)
        .patch(`/api/v1/sections/${section.id}`)
        .send({ name: 'Renamed' })
        .expect(200);
    });
  });
});
