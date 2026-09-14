import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_SCOPED_TABLES } from '../../../src/db/tenant-models.js';
import type { ProvisionedTenant } from '../../../src/modules/tenants/provisioning.js';
import {
  asRuntimeRole,
  connectTestDatabases,
  createCourseFixture,
  createTestTenant,
  populateEveryTenantTable,
  type TestDatabases,
} from '../helpers/database.js';

/**
 * Layer 3: PostgreSQL row-level security, exercised WITHOUT the Prisma tenant extension.
 * If the application layer ever forgets a tenant filter, these are the guarantees that remain.
 */
describe('row-level security (database layer alone)', () => {
  let dbs: TestDatabases;
  let lincoln: ProvisionedTenant;
  let riverside: ProvisionedTenant;
  let riversideCourseId: string;
  let lincolnSectionId: string;

  beforeAll(async () => {
    dbs = connectTestDatabases();
    lincoln = await createTestTenant(dbs.owner, 'lincoln');
    riverside = await createTestTenant(dbs.owner, 'riverside');
    await populateEveryTenantTable(dbs.owner, lincoln);
    await populateEveryTenantTable(dbs.owner, riverside);
    const lincolnCourse = await createCourseFixture(dbs.owner, lincoln);
    lincolnSectionId = lincolnCourse.sections[0]!.id;
    riversideCourseId = (await createCourseFixture(dbs.owner, riverside)).id;
  });

  afterAll(async () => {
    await dbs.close();
  });

  const tables = Object.keys(TENANT_SCOPED_TABLES);

  it.each(tables)('precondition: %s holds rows for both tenants', async (table) => {
    const rows = await dbs.owner.$queryRawUnsafe<{ tenant_id: string }[]>(
      `SELECT DISTINCT tenant_id::text FROM ${table} WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      lincoln.tenant.id,
      riverside.tenant.id,
    );

    expect(rows).toHaveLength(2);
  });

  it.each(tables)('returns no %s rows without a tenant context (fails closed)', async (table) => {
    const { rows } = await asRuntimeRole(dbs.appPool, null, (client) =>
      client.query<{ count: string }>(`SELECT count(*) FROM ${table}`),
    );

    expect(rows[0]!.count).toBe('0');
  });

  it('treats an empty tenant setting like no tenant, without errors', async () => {
    const { rows } = await asRuntimeRole(dbs.appPool, null, async (client) => {
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      return client.query<{ count: string }>('SELECT count(*) FROM courses');
    });

    expect(rows[0]!.count).toBe('0');
  });

  it.each(tables)('shows only the bound tenant’s %s rows', async (table) => {
    const { rows } = await asRuntimeRole(dbs.appPool, lincoln.tenant.id, (client) =>
      client.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${table}`),
    );

    expect(rows.map((row) => row.tenant_id)).toEqual([lincoln.tenant.id]);
  });

  it('hides another tenant’s rows even when asked for them by tenant_id and id', async () => {
    const { rows } = await asRuntimeRole(dbs.appPool, lincoln.tenant.id, (client) =>
      client.query('SELECT id FROM courses WHERE tenant_id = $1 OR id = $2', [
        riverside.tenant.id,
        riversideCourseId,
      ]),
    );

    expect(rows).toHaveLength(0);
  });

  it('cannot update or delete another tenant’s rows', async () => {
    const [updated, deleted] = await asRuntimeRole(
      dbs.appPool,
      lincoln.tenant.id,
      async (client) => [
        await client.query("UPDATE courses SET title = 'hijacked' WHERE id = $1", [
          riversideCourseId,
        ]),
        await client.query('DELETE FROM courses WHERE id = $1', [riversideCourseId]),
      ],
    );

    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);
    const course = await dbs.owner.course.findUniqueOrThrow({ where: { id: riversideCourseId } });
    expect(course.title).not.toBe('hijacked');
  });

  it('rejects inserting a row for another tenant', async () => {
    const insert = asRuntimeRole(dbs.appPool, lincoln.tenant.id, (client) =>
      client.query(
        `INSERT INTO audit_logs (id, tenant_id, actor_type, action, resource_type)
         VALUES (gen_random_uuid(), $1, 'system', 'test.forged', 'test')`,
        [riverside.tenant.id],
      ),
    );

    await expect(insert).rejects.toMatchObject({ code: '42501' });
    await expect(insert).rejects.toThrow(/row-level security/);
  });

  it('rejects moving a row into another tenant', async () => {
    const move = asRuntimeRole(dbs.appPool, lincoln.tenant.id, (client) =>
      client.query('UPDATE users SET tenant_id = $1 WHERE id = $2', [
        riverside.tenant.id,
        lincoln.admin.id,
      ]),
    );

    await expect(move).rejects.toThrow(/row-level security/);
  });

  it('shows a tenant only its own tenants row, never the list of schools', async () => {
    const { rows } = await asRuntimeRole(dbs.appPool, lincoln.tenant.id, (client) =>
      client.query<{ id: string }>('SELECT id FROM tenants'),
    );

    expect(rows.map((row) => row.id)).toEqual([lincoln.tenant.id]);
  });

  it('resolves a tenant by exact slug without a context, exposing only public fields', async () => {
    const { rows } = await asRuntimeRole(dbs.appPool, null, (client) =>
      client.query('SELECT * FROM app.resolve_tenant($1)', [riverside.tenant.slug]),
    );

    expect(rows).toEqual([
      {
        id: riverside.tenant.id,
        slug: riverside.tenant.slug,
        name: riverside.tenant.name,
        status: 'active',
        branding: {},
      },
    ]);
  });

  it('keeps the ORM fail-closed too: a raw Prisma client as the runtime role sees nothing', async () => {
    const courses = await dbs.appRaw.course.findMany({ where: { tenantId: riverside.tenant.id } });

    expect(courses).toEqual([]);
  });

  it('lets the relay role see every tenant through its explicit policy', async () => {
    const tenantIds = await dbs.system.course.findMany({
      where: { tenantId: { in: [lincoln.tenant.id, riverside.tenant.id] } },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });

    expect(tenantIds).toHaveLength(2);
  });

  it('structurally forbids cross-tenant references, even for a privileged role', async () => {
    const riversideStudent = await dbs.owner.user.create({
      data: { tenantId: riverside.tenant.id, email: 'student@riverside-fk.test', name: 'Student' },
    });

    // The owner bypasses RLS, yet the composite (tenant_id, section_id) key has no match.
    const enrollment = dbs.owner.enrollment.create({
      data: {
        tenantId: riverside.tenant.id,
        sectionId: lincolnSectionId,
        studentId: riversideStudent.id,
        source: 'admin',
      },
    });

    await expect(enrollment).rejects.toMatchObject({ code: 'P2003' });
  });
});
