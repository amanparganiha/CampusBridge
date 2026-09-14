import type { Prisma } from '../generated/prisma/client.js';

/**
 * Tenant-owned tables and their Prisma models. The tenant extension scopes exactly these
 * models, and a schema-guard test asserts this map matches every table that has a tenant_id
 * column, so a new tenant-owned table cannot be added without it being isolated.
 */
export const TENANT_SCOPED_TABLES = {
  users: 'User',
  user_identities: 'UserIdentity',
  roles: 'Role',
  role_permissions: 'RolePermission',
  user_roles: 'UserRole',
  sessions: 'Session',
  refresh_tokens: 'RefreshToken',
  api_keys: 'ApiKey',
  invitations: 'Invitation',
  courses: 'Course',
  sections: 'Section',
  enrollments: 'Enrollment',
  grades: 'Grade',
  audit_logs: 'AuditLog',
  outbox_events: 'OutboxEvent',
  idempotency_keys: 'IdempotencyKey',
} as const satisfies Record<string, Prisma.ModelName>;

export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Object.values(TENANT_SCOPED_TABLES),
);
