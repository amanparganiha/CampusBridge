import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProblemDetails } from '../../../src/lib/errors.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { connectTestDatabases, createTestUser, type TestDatabases } from '../helpers/database.js';
import {
  as,
  createActor,
  createSchool,
  signIn,
  type Actor,
  type SchoolFixture,
} from '../helpers/school.js';

interface UserBody {
  id: string;
  email: string;
  name: string;
  status: 'invited' | 'active' | 'suspended';
  roles: string[];
}
interface PageBody<T> {
  data: T[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}

const problem = (response: { body: unknown }) => response.body as ProblemDetails;

describe('users and roles', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: SchoolFixture;

  const api = (actor: Actor) => as(testApp.app, actor);

  /** A custom role holding exactly `permissions`, and a signed-in user who has only that role. */
  async function actorWithCustomRole(key: string, permissions: string[]): Promise<Actor> {
    const role = await dbs.owner.role.create({ data: { tenantId: school.id, key, name: key } });
    await dbs.owner.rolePermission.createMany({
      data: permissions.map((permissionKey) => ({
        tenantId: school.id,
        roleId: role.id,
        permissionKey,
      })),
    });
    const user = await createTestUser(dbs.owner, school.tenant, { role: 'student' });
    await dbs.owner.userRole.deleteMany({ where: { userId: user.id } });
    await dbs.owner.userRole.create({
      data: { tenantId: school.id, userId: user.id, roleId: role.id },
    });
    return signIn(testApp.app, school.tenant, user);
  }

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    school = await createSchool(dbs, testApp.app, 'users');
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  describe('listing', () => {
    it('filters by role, status and a name/email search', async () => {
      const students = (await api(school.admin).get('/api/v1/users?role=student').expect(200))
        .body as PageBody<UserBody>;
      expect(students.data.length).toBeGreaterThan(0);
      expect(students.data.every((user) => user.roles.includes('student'))).toBe(true);

      const search = (
        await api(school.instructor)
          .get(`/api/v1/users?q=${encodeURIComponent(school.student.email.toUpperCase())}`)
          .expect(200)
      ).body as PageBody<UserBody>;
      expect(search.data.map((user) => user.id)).toEqual([school.student.id]);
    });

    it('pages with keyset cursors that are bound to their sort order', async () => {
      const first = (await api(school.admin).get('/api/v1/users?limit=1&sort=email').expect(200))
        .body as PageBody<UserBody>;
      expect(first.pageInfo.hasMore).toBe(true);
      const cursor = first.pageInfo.nextCursor ?? '';

      const second = (
        await api(school.admin).get(`/api/v1/users?limit=1&sort=email&cursor=${cursor}`).expect(200)
      ).body as PageBody<UserBody>;
      expect(second.data).toHaveLength(1);
      expect(second.data[0]?.id).not.toBe(first.data[0]?.id);

      const mismatched = await api(school.admin)
        .get(`/api/v1/users?limit=1&sort=-email&cursor=${cursor}`)
        .expect(400);
      expect(problem(mismatched).code).toBe('INVALID_CURSOR');
    });

    it('never exposes password hashes', async () => {
      const response = await api(school.admin)
        .get(`/api/v1/users/${school.student.id}`)
        .expect(200);
      expect(Object.keys(response.body as object).sort()).toEqual(
        ['createdAt', 'email', 'id', 'lastLoginAt', 'name', 'roles', 'status'].sort(),
      );
    });
  });

  describe('suspension', () => {
    it('ends every session of a suspended user at once, and is audited', async () => {
      const student = await createActor(dbs, testApp.app, school.tenant, 'student');
      await api(student).get('/api/v1/auth/me').expect(200);

      const suspended = await api(school.admin)
        .patch(`/api/v1/users/${student.id}`)
        .send({ status: 'suspended' })
        .expect(200);
      expect((suspended.body as UserBody).status).toBe('suspended');

      const refused = await api(student).get('/api/v1/auth/me').expect(401);
      expect(problem(refused).code).toBe('SESSION_REVOKED');

      await api(school.admin)
        .patch(`/api/v1/users/${student.id}`)
        .send({ status: 'active' })
        .expect(200);
      const trail = await dbs.owner.auditLog.findMany({
        where: { tenantId: school.id, resourceId: student.id },
        orderBy: { id: 'asc' },
      });
      expect(trail.map((entry) => entry.action)).toEqual(['user.suspended', 'user.reactivated']);
      const events = await dbs.owner.outboxEvent.findMany({
        where: { tenantId: school.id, aggregateId: student.id },
        orderBy: { id: 'asc' },
      });
      expect(events.map((event) => event.payload)).toEqual([
        { userId: student.id, from: 'active', to: 'suspended' },
        { userId: student.id, from: 'suspended', to: 'active' },
      ]);
    });

    it('refuses to let administrators suspend themselves', async () => {
      const response = await api(school.admin)
        .patch(`/api/v1/users/${school.admin.id}`)
        .send({ status: 'suspended' })
        .expect(422);
      expect(problem(response).code).toBe('CANNOT_SUSPEND_SELF');
    });
  });

  describe('role assignment', () => {
    it('replaces roles, and removing one ends the user’s sessions', async () => {
      const user = await createActor(dbs, testApp.app, school.tenant, 'student');

      const promoted = await api(school.admin)
        .put(`/api/v1/users/${user.id}/roles`)
        .send({ roles: ['student', 'instructor'] })
        .expect(200);
      expect((promoted.body as UserBody).roles.sort()).toEqual(['instructor', 'student']);
      // Adding a role does not sign anyone out.
      await api(user).get('/api/v1/auth/me').expect(200);

      await api(school.admin)
        .put(`/api/v1/users/${user.id}/roles`)
        .send({ roles: ['student'] })
        .expect(200);
      await api(user).get('/api/v1/auth/me').expect(401);

      const audit = await dbs.owner.auditLog.findFirstOrThrow({
        where: { tenantId: school.id, resourceId: user.id, action: 'user.roles_changed' },
        orderBy: { id: 'desc' },
      });
      expect(audit.metadata).toEqual({ before: ['instructor', 'student'], after: ['student'] });
    });

    it('rejects unknown roles', async () => {
      const response = await api(school.admin)
        .put(`/api/v1/users/${school.student.id}/roles`)
        .send({ roles: ['wizard'] })
        .expect(422);
      expect(problem(response).code).toBe('UNKNOWN_ROLE');
    });

    it('prevents privilege escalation: you can only grant or remove roles you could hold', async () => {
      const studentPermissions = [
        'tenant:read',
        'course:read',
        'enrollment:read',
        'enrollment:self',
        'grade:read',
        'payment:read',
        'payment:create',
        'file:read',
      ];
      const registrar = await actorWithCustomRole('registrar', [
        ...studentPermissions,
        'user:read',
        'role:assign',
      ]);
      const target = await createTestUser(dbs.owner, school.tenant, { role: 'instructor' });

      const toAdmin = await api(registrar)
        .put(`/api/v1/users/${target.id}/roles`)
        .send({ roles: ['instructor', 'admin'] })
        .expect(403);
      expect(problem(toAdmin).code).toBe('ROLE_NOT_GRANTABLE');

      const selfPromotion = await api(registrar)
        .put(`/api/v1/users/${registrar.id}/roles`)
        .send({ roles: ['registrar', 'admin'] })
        .expect(403);
      expect(problem(selfPromotion).code).toBe('ROLE_NOT_GRANTABLE');

      // Removing a role is guarded the same way: the registrar cannot strip an instructor.
      const demotion = await api(registrar)
        .put(`/api/v1/users/${target.id}/roles`)
        .send({ roles: ['student'] })
        .expect(403);
      expect(problem(demotion).code).toBe('ROLE_NOT_GRANTABLE');

      const newcomer = await createTestUser(dbs.owner, school.tenant, { role: 'student' });
      await dbs.owner.userRole.deleteMany({ where: { userId: newcomer.id } });
      await api(registrar)
        .put(`/api/v1/users/${newcomer.id}/roles`)
        .send({ roles: ['student'] })
        .expect(200);
    });

    it('always keeps an active administrator, even under concurrent demotions', async () => {
      const solo = await createSchool(dbs, testApp.app, 'solo-admin');
      const alone = await as(testApp.app, solo.admin)
        .put(`/api/v1/users/${solo.admin.id}/roles`)
        .send({ roles: ['instructor'] })
        .expect(409);
      expect(problem(alone).code).toBe('LAST_ADMIN');

      const second = await createActor(dbs, testApp.app, solo.tenant, 'admin');
      const results = await Promise.all([
        as(testApp.app, solo.admin)
          .put(`/api/v1/users/${second.id}/roles`)
          .send({ roles: ['instructor'] }),
        as(testApp.app, second)
          .put(`/api/v1/users/${solo.admin.id}/roles`)
          .send({ roles: ['instructor'] }),
      ]);

      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      const admins = await dbs.owner.userRole.count({
        where: { tenantId: solo.id, role: { key: 'admin' }, user: { status: 'active' } },
      });
      expect(admins).toBe(1);
    });

    it('lists roles with the permissions they grant', async () => {
      const response = await api(school.admin).get('/api/v1/roles').expect(200);
      const roles = (
        response.body as { data: { key: string; isSystem: boolean; permissions: string[] }[] }
      ).data;

      expect(roles.filter((role) => role.isSystem).map((role) => role.key)).toEqual([
        'admin',
        'instructor',
        'student',
      ]);
      expect(roles.find((role) => role.key === 'student')?.permissions).toContain(
        'enrollment:self',
      );
    });
  });
});
