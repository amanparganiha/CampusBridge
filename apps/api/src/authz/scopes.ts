import type { Principal } from '../auth/principal.js';
import type { EnrollmentStatus, Prisma } from '../generated/prisma/client.js';

/**
 * List-query equivalents of the rules in policies.ts: filters that return exactly the records a
 * principal may see, so lists never have to be post-filtered (which breaks pagination) and a
 * forgotten check cannot leak rows. Keep each filter in lockstep with its policy function; the
 * integration tests compare them on real data.
 */

const COUNTS_AS_ENROLLED: EnrollmentStatus[] = ['active', 'completed'];

export function visibleCoursesWhere(principal: Principal): Prisma.CourseWhereInput {
  if (principal.kind === 'api_key' || principal.permissions.has('course:manage_all')) return {};
  const { userId } = principal;
  return {
    OR: [
      { ownerId: userId },
      { sections: { some: { instructorId: userId } } },
      {
        sections: {
          some: {
            enrollments: { some: { studentId: userId, status: { in: COUNTS_AS_ENROLLED } } },
          },
        },
      },
    ],
  };
}

export function visibleEnrollmentsWhere(principal: Principal): Prisma.EnrollmentWhereInput {
  if (principal.kind === 'api_key' || principal.permissions.has('enrollment:read_all')) return {};
  const { userId } = principal;
  return {
    OR: [
      { studentId: userId },
      { section: { instructorId: userId } },
      { section: { course: { ownerId: userId } } },
    ],
  };
}
