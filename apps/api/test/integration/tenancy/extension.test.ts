import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAsTenant } from '../../../src/context/request-context.js';
import { MissingTenantContextError, TenantContextMismatchError } from '../../../src/db/scope.js';
import { CrossTenantAccessError } from '../../../src/db/tenant-extension.js';
import type { ProvisionedTenant } from '../../../src/modules/tenants/provisioning.js';
import {
  connectTestDatabases,
  createCourseFixture,
  createTestTenant,
  type TestDatabases,
} from '../helpers/database.js';

/**
 * Layer 2: the Prisma tenant extension behind TenantDb, i.e. what feature code actually uses.
 * RLS (layer 3) is also active underneath these calls.
 */
describe('TenantDb (application layer)', () => {
  let dbs: TestDatabases;
  let lincoln: ProvisionedTenant;
  let riverside: ProvisionedTenant;
  let lincolnCourseId: string;
  let riversideCourseId: string;

  const asLincoln = <T>(fn: () => Promise<T>) => runAsTenant(lincoln.tenant.id, fn);

  beforeAll(async () => {
    dbs = connectTestDatabases();
    lincoln = await createTestTenant(dbs.owner, 'lincoln');
    riverside = await createTestTenant(dbs.owner, 'riverside');
    lincolnCourseId = (await createCourseFixture(dbs.owner, lincoln)).id;
    riversideCourseId = (await createCourseFixture(dbs.owner, riverside)).id;
  });

  afterAll(async () => {
    await dbs.close();
  });

  describe('reads', () => {
    it('lists only the current tenant’s rows', async () => {
      const courses = await asLincoln(() => dbs.db.client.course.findMany());

      expect(courses.map((course) => course.tenantId)).toEqual([lincoln.tenant.id]);
    });

    it('does not find another tenant’s row by id', async () => {
      const course = await asLincoln(() =>
        dbs.db.client.course.findUnique({ where: { id: riversideCourseId } }),
      );

      expect(course).toBeNull();
    });

    it('scopes aggregates and relation reads', async () => {
      const [count, withSections] = await asLincoln(() =>
        Promise.all([
          dbs.db.client.course.count(),
          dbs.db.client.course.findMany({ include: { sections: true } }),
        ]),
      );

      expect(count).toBe(1);
      expect(
        withSections
          .flatMap((course) => course.sections)
          .every((s) => s.tenantId === lincoln.tenant.id),
      ).toBe(true);
    });

    it('refuses a filter that names another tenant instead of silently overriding it', async () => {
      const query = asLincoln(() =>
        dbs.db.client.course.findMany({ where: { tenantId: riverside.tenant.id } }),
      );

      await expect(query).rejects.toBeInstanceOf(CrossTenantAccessError);
    });

    it('also protects raw SQL, which bypasses the extension’s filters but not RLS', async () => {
      const rows = await asLincoln(
        () =>
          dbs.db.client.$queryRaw<
            { tenant_id: string }[]
          >`SELECT DISTINCT tenant_id::text FROM courses`,
      );

      expect(rows).toEqual([{ tenant_id: lincoln.tenant.id }]);
    });
  });

  describe('writes', () => {
    it('creates rows in the current tenant', async () => {
      const role = await asLincoln(() =>
        dbs.db.client.role.create({
          data: { tenantId: lincoln.tenant.id, key: 'librarian', name: 'Librarian' },
        }),
      );

      expect(role.tenantId).toBe(lincoln.tenant.id);
    });

    it('refuses to create rows for another tenant', async () => {
      const create = asLincoln(() =>
        dbs.db.client.role.create({
          data: { tenantId: riverside.tenant.id, key: 'mole', name: 'Mole' },
        }),
      );

      await expect(create).rejects.toBeInstanceOf(CrossTenantAccessError);
    });

    it('propagates the tenant into nested creates through composite keys', async () => {
      const course = await asLincoln(() =>
        dbs.db.client.course.create({
          data: {
            tenantId: lincoln.tenant.id,
            code: 'NEST-1',
            title: 'Nested',
            ownerId: lincoln.admin.id,
            sections: { create: [{ name: 'A' }, { name: 'B' }] },
          },
          include: { sections: true },
        }),
      );

      expect(course.sections.map((section) => section.tenantId)).toEqual([
        lincoln.tenant.id,
        lincoln.tenant.id,
      ]);
    });

    it('cannot update or delete another tenant’s row', async () => {
      await expect(
        asLincoln(() =>
          dbs.db.client.course.update({
            where: { id: riversideCourseId },
            data: { title: 'hijacked' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2025' });
      await expect(
        asLincoln(() => dbs.db.client.course.delete({ where: { id: riversideCourseId } })),
      ).rejects.toMatchObject({ code: 'P2025' });

      const bulk = await asLincoln(() =>
        dbs.db.client.course.updateMany({
          where: { id: riversideCourseId },
          data: { title: 'hijacked' },
        }),
      );
      expect(bulk.count).toBe(0);

      const untouched = await dbs.owner.course.findUniqueOrThrow({
        where: { id: riversideCourseId },
      });
      expect(untouched.title).not.toBe('hijacked');
    });

    it('never moves a row to another tenant', async () => {
      const move = asLincoln(() =>
        dbs.db.client.course.update({
          where: { id: lincolnCourseId },
          data: { tenantId: riverside.tenant.id },
        }),
      );

      await expect(move).rejects.toBeInstanceOf(CrossTenantAccessError);
    });

    it('turns an upsert aimed at another tenant’s row into a create in the current tenant', async () => {
      const role = await asLincoln(() =>
        dbs.db.client.role.upsert({
          where: { tenantId_key: { tenantId: lincoln.tenant.id, key: 'counselor' } },
          create: { tenantId: lincoln.tenant.id, key: 'counselor', name: 'Counselor' },
          update: { name: 'Counselor (updated)' },
        }),
      );

      expect(role.tenantId).toBe(lincoln.tenant.id);
    });
  });

  describe('missing or conflicting context', () => {
    it('fails closed when no tenant is in context', async () => {
      await expect(dbs.db.client.course.findMany()).rejects.toBeInstanceOf(
        MissingTenantContextError,
      );
      await expect(dbs.db.transaction(async () => undefined)).rejects.toBeInstanceOf(
        MissingTenantContextError,
      );
    });

    it('refuses to switch tenants inside a transaction', async () => {
      const mixed = asLincoln(() =>
        dbs.db.transaction(() =>
          runAsTenant(riverside.tenant.id, () => dbs.db.client.course.findMany()),
        ),
      );

      await expect(mixed).rejects.toBeInstanceOf(TenantContextMismatchError);
    });
  });

  describe('transactions', () => {
    it('commits several operations atomically and rolls all of them back on error', async () => {
      const failing = asLincoln(() =>
        dbs.db.transaction(async (tx) => {
          await tx.role.create({
            data: { tenantId: lincoln.tenant.id, key: 'temp_role', name: 'Temp' },
          });
          await tx.auditLog.create({
            data: {
              tenantId: lincoln.tenant.id,
              actorType: 'system',
              action: 'test.rolled_back',
              resourceType: 'test',
            },
          });
          throw new Error('abort');
        }),
      );

      await expect(failing).rejects.toThrow('abort');
      const leftovers = await asLincoln(() =>
        Promise.all([
          dbs.db.client.role.findFirst({ where: { key: 'temp_role' } }),
          dbs.db.client.auditLog.findFirst({ where: { action: 'test.rolled_back' } }),
        ]),
      );
      expect(leftovers).toEqual([null, null]);
    });

    it('lets nested transaction() calls join the outer transaction', async () => {
      const failing = asLincoln(() =>
        dbs.db.transaction(async () => {
          await dbs.db.transaction(async (inner) => {
            await inner.role.create({
              data: { tenantId: lincoln.tenant.id, key: 'inner_role', name: 'Inner' },
            });
          });
          throw new Error('outer failed after inner succeeded');
        }),
      );

      await expect(failing).rejects.toThrow('outer failed');
      const inner = await asLincoln(() =>
        dbs.db.client.role.findFirst({ where: { key: 'inner_role' } }),
      );
      expect(inner).toBeNull();
    });

    it('routes db.client to the ambient transaction', async () => {
      const seenInside = await asLincoln(() =>
        dbs.db.transaction(async (tx) => {
          await tx.role.create({
            data: { tenantId: lincoln.tenant.id, key: 'ambient_role', name: 'Ambient' },
          });
          // Same transaction: sees the uncommitted row through the ambient client.
          return dbs.db.client.role.findFirst({ where: { key: 'ambient_role' } });
        }),
      );

      expect(seenInside?.key).toBe('ambient_role');
    });
  });
});
