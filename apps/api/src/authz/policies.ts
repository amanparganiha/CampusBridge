import type { Principal, UserPrincipal } from '../auth/principal.js';
import type { CourseStatus } from '../generated/prisma/client.js';

/**
 * Attribute-based access rules (ABAC) layered on top of RBAC permissions.
 *
 * A permission says what kind of action a role may take ("course:update"); these rules decide
 * *which* records it applies to ("only courses you own"). They are pure functions of the
 * principal and a few facts about the record, so they are trivially unit-testable and the same
 * rules back both single-record checks and list filters (see scopes.ts).
 *
 * API keys are tenant-level service accounts: within their scopes, ownership rules do not apply.
 */

/** Facts about a course that access decisions depend on. */
export interface CourseFacts {
  ownerId: string;
  status: CourseStatus;
  /** Instructors of the course's sections. */
  instructorIds: readonly string[];
  /** Students with an active or completed enrollment in one of its sections. */
  enrolledStudentIds: readonly string[];
}

/** Facts about an enrollment (and the course/section it belongs to). */
export interface EnrollmentFacts {
  studentId: string;
  courseOwnerId: string;
  sectionInstructorId: string | null;
}

const isServiceAccount = (principal: Principal) => principal.kind === 'api_key';

function teaches(principal: UserPrincipal, enrollment: EnrollmentFacts): boolean {
  return (
    enrollment.courseOwnerId === principal.userId ||
    enrollment.sectionInstructorId === principal.userId
  );
}

/**
 * Full course details (roster, materials, grades). The public catalog is a separate, narrower
 * projection anyone with `course:read` may browse.
 */
export function canViewCourse(principal: Principal, course: CourseFacts): boolean {
  if (!principal.permissions.has('course:read')) return false;
  if (isServiceAccount(principal) || principal.permissions.has('course:manage_all')) return true;
  const { userId } = principal;
  return (
    course.ownerId === userId ||
    course.instructorIds.includes(userId) ||
    course.enrolledStudentIds.includes(userId)
  );
}

/** Edit, publish, archive; manage sections and materials. The owner, or an administrator. */
export function canManageCourse(
  principal: Principal,
  course: Pick<CourseFacts, 'ownerId'>,
): boolean {
  if (!principal.permissions.has('course:update')) return false;
  if (isServiceAccount(principal) || principal.permissions.has('course:manage_all')) return true;
  return course.ownerId === principal.userId;
}

export function canDeleteCourse(
  principal: Principal,
  course: Pick<CourseFacts, 'ownerId'>,
): boolean {
  return principal.permissions.has('course:delete') && canManageCourse(principal, course);
}

/** See an enrollment: your own, or one in a course or section you teach. */
export function canViewEnrollment(principal: Principal, enrollment: EnrollmentFacts): boolean {
  if (!principal.permissions.has('enrollment:read')) return false;
  if (isServiceAccount(principal) || principal.permissions.has('enrollment:read_all')) return true;
  const user = principal;
  return enrollment.studentId === user.userId || teaches(user, enrollment);
}

export function canViewGrades(principal: Principal, enrollment: EnrollmentFacts): boolean {
  return principal.permissions.has('grade:read') && canViewEnrollment(principal, enrollment);
}

/** Record grades or change an enrollment's status: whoever teaches it, or an administrator. */
export function canGradeEnrollment(principal: Principal, enrollment: EnrollmentFacts): boolean {
  if (!principal.permissions.has('grade:write')) return false;
  if (isServiceAccount(principal) || principal.permissions.has('course:manage_all')) return true;
  return teaches(principal, enrollment);
}
