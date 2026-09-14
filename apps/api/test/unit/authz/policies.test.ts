import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApiKeyPrincipal, UserPrincipal } from '../../../src/auth/principal.js';
import { SYSTEM_ROLES, type Permission } from '../../../src/authz/permissions.js';
import {
  canDeleteCourse,
  canGradeEnrollment,
  canManageCourse,
  canViewCourse,
  canViewEnrollment,
  canViewGrades,
  type CourseFacts,
  type EnrollmentFacts,
} from '../../../src/authz/policies.js';

const tenantId = randomUUID();

function user(role: keyof typeof SYSTEM_ROLES, userId = randomUUID()): UserPrincipal {
  return {
    kind: 'user',
    tenantId,
    userId,
    sessionId: randomUUID(),
    roles: [role],
    permissions: new Set(SYSTEM_ROLES[role].permissions),
  };
}

function apiKey(scopes: Permission[]): ApiKeyPrincipal {
  return { kind: 'api_key', tenantId, apiKeyId: randomUUID(), permissions: new Set(scopes) };
}

const admin = user('admin');
const owner = user('instructor');
const coTeacher = user('instructor');
const otherInstructor = user('instructor');
const enrolled = user('student');
const stranger = user('student');

const course: CourseFacts = {
  ownerId: owner.userId,
  status: 'published',
  instructorIds: [coTeacher.userId],
  enrolledStudentIds: [enrolled.userId],
};

const enrollment: EnrollmentFacts = {
  studentId: enrolled.userId,
  courseOwnerId: owner.userId,
  sectionInstructorId: coTeacher.userId,
};

describe('course policies', () => {
  it.each([
    ['an administrator', admin, true],
    ['the owning instructor', owner, true],
    ['an instructor of one of its sections', coTeacher, true],
    ['an enrolled student', enrolled, true],
    ['an unrelated instructor', otherInstructor, false],
    ['an unenrolled student', stranger, false],
  ])('shows full course details to %s: %s', (_label, principal, expected) => {
    expect(canViewCourse(principal, course)).toBe(expected);
  });

  it.each([
    ['an administrator', admin, true],
    ['the owning instructor', owner, true],
    ['a section instructor, who teaches but does not own it', coTeacher, false],
    ['an unrelated instructor', otherInstructor, false],
    ['an enrolled student', enrolled, false],
  ])('lets %s manage the course: %s', (_label, principal, expected) => {
    expect(canManageCourse(principal, course)).toBe(expected);
  });

  it('requires the delete permission on top of management rights', () => {
    const ownerWithoutDelete: UserPrincipal = {
      ...owner,
      permissions: new Set(
        [...owner.permissions].filter((permission) => permission !== 'course:delete'),
      ),
    };

    expect(canDeleteCourse(owner, course)).toBe(true);
    expect(canDeleteCourse(ownerWithoutDelete, course)).toBe(false);
  });

  it('treats an API key as a service account limited to its scopes', () => {
    expect(canViewCourse(apiKey(['course:read']), course)).toBe(true);
    expect(canManageCourse(apiKey(['course:read']), course)).toBe(false);
    expect(canManageCourse(apiKey(['course:read', 'course:update']), course)).toBe(true);
    expect(canViewCourse(apiKey(['enrollment:read']), course)).toBe(false);
  });
});

describe('enrollment and grade policies', () => {
  it.each([
    ['the student themself', enrolled, true],
    ['the course owner', owner, true],
    ['the section instructor', coTeacher, true],
    ['an administrator', admin, true],
    ['another student', stranger, false],
    ['an unrelated instructor', otherInstructor, false],
  ])('shows the enrollment and grades to %s: %s', (_label, principal, expected) => {
    expect(canViewEnrollment(principal, enrollment)).toBe(expected);
    expect(canViewGrades(principal, enrollment)).toBe(expected);
  });

  it.each([
    ['the course owner', owner, true],
    ['the section instructor', coTeacher, true],
    ['an administrator', admin, true],
    ['the student themself', enrolled, false],
    ['an unrelated instructor', otherInstructor, false],
  ])('lets %s record grades: %s', (_label, principal, expected) => {
    expect(canGradeEnrollment(principal, enrollment)).toBe(expected);
  });
});
