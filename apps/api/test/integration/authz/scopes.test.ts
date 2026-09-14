import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal, UserPrincipal } from '../../../src/auth/principal.js';
import { SYSTEM_ROLES, type Permission } from '../../../src/authz/permissions.js';
import { canViewCourse, canViewEnrollment, type CourseFacts } from '../../../src/authz/policies.js';
import { visibleCoursesWhere, visibleEnrollmentsWhere } from '../../../src/authz/scopes.js';
import { runAsTenant } from '../../../src/context/request-context.js';
import type { ProvisionedTenant } from '../../../src/modules/tenants/provisioning.js';
import {
  connectTestDatabases,
  createTestTenant,
  createTestUser,
  type TestDatabases,
} from '../helpers/database.js';

/**
 * The list filters (scopes.ts) and the single-record rules (policies.ts) must agree, or a list
 * would show records a detail view refuses (or hide ones it allows). Checked on real data, for
 * every principal against every record.
 */
describe('ABAC list filters agree with the policies', () => {
  let dbs: TestDatabases;
  let school: ProvisionedTenant;
  const principals: Record<string, Principal> = {};

  const asUser = (userId: string, role: keyof typeof SYSTEM_ROLES): UserPrincipal => ({
    kind: 'user',
    tenantId: school.tenant.id,
    userId,
    sessionId: crypto.randomUUID(),
    roles: [role],
    permissions: new Set(SYSTEM_ROLES[role].permissions),
  });

  beforeAll(async () => {
    dbs = connectTestDatabases();
    school = await createTestTenant(dbs.owner, 'scopes');
    const tenantId = school.tenant.id;
    const [owner, coTeacher, outsider, enrolled, dropped, stranger] = await Promise.all([
      createTestUser(dbs.owner, school, { role: 'instructor' }),
      createTestUser(dbs.owner, school, { role: 'instructor' }),
      createTestUser(dbs.owner, school, { role: 'instructor' }),
      createTestUser(dbs.owner, school, { role: 'student' }),
      createTestUser(dbs.owner, school, { role: 'student' }),
      createTestUser(dbs.owner, school, { role: 'student' }),
    ]);

    // Course A: owned by `owner`, a section taught by `coTeacher`; one active and one dropped student.
    const courseA = await dbs.owner.course.create({
      data: { tenantId, code: 'A-1', title: 'A', ownerId: owner.id, status: 'published' },
    });
    const sectionA = await dbs.owner.section.create({
      data: { tenantId, courseId: courseA.id, name: 'A1', instructorId: coTeacher.id },
    });
    await dbs.owner.enrollment.createMany({
      data: [
        {
          tenantId,
          sectionId: sectionA.id,
          studentId: enrolled.id,
          source: 'admin',
          status: 'active',
        },
        {
          tenantId,
          sectionId: sectionA.id,
          studentId: dropped.id,
          source: 'admin',
          status: 'dropped',
        },
      ],
    });
    // Course B: owned by `outsider`, no sections.
    await dbs.owner.course.create({
      data: { tenantId, code: 'B-1', title: 'B', ownerId: outsider.id },
    });

    Object.assign(principals, {
      admin: asUser(school.admin.id, 'admin'),
      owner: asUser(owner.id, 'instructor'),
      coTeacher: asUser(coTeacher.id, 'instructor'),
      outsider: asUser(outsider.id, 'instructor'),
      enrolled: asUser(enrolled.id, 'student'),
      dropped: asUser(dropped.id, 'student'),
      stranger: asUser(stranger.id, 'student'),
      partnerKey: {
        kind: 'api_key',
        tenantId,
        apiKeyId: crypto.randomUUID(),
        permissions: new Set<Permission>(['course:read', 'enrollment:read']),
      },
    });
  });

  afterAll(async () => {
    await dbs.close();
  });

  it('courses: the list filter returns exactly what canViewCourse allows', async () => {
    await runAsTenant(school.tenant.id, async () => {
      const courses = await dbs.db.client.course.findMany({
        include: { sections: { include: { enrollments: true } } },
      });
      expect(courses).toHaveLength(2);

      for (const [name, principal] of Object.entries(principals)) {
        const visible = new Set(
          (
            await dbs.db.client.course.findMany({
              where: visibleCoursesWhere(principal),
              select: { code: true },
            })
          ).map((course) => course.code),
        );
        for (const course of courses) {
          const facts: CourseFacts = {
            ownerId: course.ownerId,
            status: course.status,
            instructorIds: course.sections.flatMap((section) =>
              section.instructorId ? [section.instructorId] : [],
            ),
            enrolledStudentIds: course.sections.flatMap((section) =>
              section.enrollments
                .filter(
                  (enrollment) =>
                    enrollment.status === 'active' || enrollment.status === 'completed',
                )
                .map((enrollment) => enrollment.studentId),
            ),
          };
          expect(`${name} sees ${course.code}: ${String(visible.has(course.code))}`).toBe(
            `${name} sees ${course.code}: ${String(canViewCourse(principal, facts))}`,
          );
        }
      }
    });
  });

  it('enrollments: the list filter returns exactly what canViewEnrollment allows', async () => {
    await runAsTenant(school.tenant.id, async () => {
      const enrollments = await dbs.db.client.enrollment.findMany({
        include: { section: { include: { course: true } } },
      });
      expect(enrollments).toHaveLength(2);

      for (const [name, principal] of Object.entries(principals)) {
        const visible = new Set(
          (
            await dbs.db.client.enrollment.findMany({
              where: visibleEnrollmentsWhere(principal),
              select: { id: true },
            })
          ).map((enrollment) => enrollment.id),
        );
        for (const enrollment of enrollments) {
          const allowed = canViewEnrollment(principal, {
            studentId: enrollment.studentId,
            courseOwnerId: enrollment.section.course.ownerId,
            sectionInstructorId: enrollment.section.instructorId,
          });
          expect(`${name} sees ${enrollment.id}: ${String(visible.has(enrollment.id))}`).toBe(
            `${name} sees ${enrollment.id}: ${String(allowed)}`,
          );
        }
      }
    });
  });
});
