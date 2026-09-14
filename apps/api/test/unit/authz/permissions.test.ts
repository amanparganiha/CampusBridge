import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, SYSTEM_ROLES, type Permission } from '../../../src/authz/permissions.js';

describe('system roles', () => {
  it('gives administrators every permission', () => {
    expect([...SYSTEM_ROLES.admin.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it.each<Permission>([
    'tenant:update',
    'user:invite',
    'role:assign',
    'apikey:manage',
    'payment:refund',
    'integration:manage',
    'webhook:manage',
    'audit:read',
  ])('reserves %s for administrators', (permission) => {
    expect(SYSTEM_ROLES.instructor.permissions).not.toContain(permission);
    expect(SYSTEM_ROLES.student.permissions).not.toContain(permission);
  });

  it('lets students act on their own learning but not manage courses or grades', () => {
    expect(SYSTEM_ROLES.student.permissions).toEqual(
      expect.arrayContaining(['enrollment:self', 'payment:create', 'grade:read']),
    );
    expect(SYSTEM_ROLES.student.permissions).not.toEqual(expect.arrayContaining(['course:create']));
    expect(SYSTEM_ROLES.student.permissions).not.toContain('grade:write');
  });

  it('lists each permission at most once per role', () => {
    for (const role of Object.values(SYSTEM_ROLES)) {
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });
});
