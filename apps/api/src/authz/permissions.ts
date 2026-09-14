/**
 * The permission catalog: the single list of capabilities the API checks (RBAC).
 *
 * The same list is seeded into the `permissions` table by migrations so role_permissions can
 * reference it; an integration test fails if the two drift apart. Adding a permission therefore
 * means: add it here, add a migration that inserts it (and grants it to system roles if needed).
 *
 * Several permissions are further narrowed by attribute-based rules (src/authz/policies), e.g.
 * an instructor's `course:update` applies only to courses they own.
 */
export const PERMISSIONS = {
  'tenant:read': 'View the school profile and settings',
  'tenant:update': 'Update the school profile, branding and settings',
  'user:read': 'View users',
  'user:invite': 'Invite users',
  'user:update': 'Update and suspend users',
  'role:read': 'View roles and their permissions',
  'role:assign': 'Assign and remove user roles',
  'apikey:manage': 'Create and revoke API keys',
  'course:read': 'View courses and sections',
  'course:create': 'Create courses',
  'course:update': 'Update courses and manage their sections',
  'course:delete': 'Archive or delete courses',
  'course:manage_all': 'Manage every course, not only your own',
  'enrollment:read': 'View enrollments',
  'enrollment:read_all': 'View every enrollment and grade in the school',
  'enrollment:manage': 'Enroll students and change enrollment status',
  'enrollment:self': 'Enroll yourself in open courses',
  'grade:read': 'View grades',
  'grade:write': 'Record and edit grades',
  'payment:read': 'View payments',
  'payment:create': 'Pay for course enrollments',
  'payment:refund': 'Refund payments',
  'file:read': 'Download course materials',
  'file:upload': 'Upload course materials',
  'integration:read': 'View integrations and sync history',
  'integration:manage': 'Connect, disconnect and sync integrations',
  'webhook:manage': 'Manage outgoing webhook endpoints',
  'audit:read': 'View the audit log',
  'audit:export': 'Export the audit log',
  'ai:use': 'Use AI assistance features',
} as const satisfies Record<string, string>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export type SystemRoleKey = 'admin' | 'instructor' | 'student';

interface SystemRoleDefinition {
  name: string;
  description: string;
  permissions: readonly Permission[];
}

/** Roles every school gets at provisioning. Schools may add custom roles on top. */
export const SYSTEM_ROLES: Record<SystemRoleKey, SystemRoleDefinition> = {
  admin: {
    name: 'Administrator',
    description: 'Full control of the school account.',
    permissions: ALL_PERMISSIONS,
  },
  instructor: {
    name: 'Instructor',
    description: 'Teaches courses: manages their own courses, sections, rosters and grades.',
    permissions: [
      'tenant:read',
      'user:read',
      'course:read',
      'course:create',
      'course:update',
      'course:delete',
      'enrollment:read',
      'enrollment:manage',
      'grade:read',
      'grade:write',
      'file:read',
      'file:upload',
      'ai:use',
    ],
  },
  student: {
    name: 'Student',
    description: 'Learns: sees and pays for their own enrollments and grades.',
    permissions: [
      'tenant:read',
      'course:read',
      'enrollment:read',
      'enrollment:self',
      'grade:read',
      'payment:read',
      'payment:create',
      'file:read',
    ],
  },
};
