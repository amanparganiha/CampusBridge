import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { seedDemoTenants } from '../../../prisma/seed-demo.js';
import { SYSTEM_ROLES } from '../../../src/authz/permissions.js';
import { runAsTenant } from '../../../src/context/request-context.js';
import { verifyPassword } from '../../../src/lib/password.js';
import { provisionTenant } from '../../../src/modules/tenants/provisioning.js';
import { connectTestDatabases, createTestTenant, type TestDatabases } from '../helpers/database.js';

describe('tenant provisioning', () => {
  let dbs: TestDatabases;

  beforeAll(() => {
    dbs = connectTestDatabases();
  });

  afterAll(async () => {
    await dbs.close();
  });

  it('creates the school, its system roles with their permissions, and the first admin', async () => {
    const provisioned = await createTestTenant(dbs.owner, 'provision');
    const tenantId = provisioned.tenant.id;

    const roles = await dbs.owner.role.findMany({
      where: { tenantId },
      include: { rolePermissions: true },
      orderBy: { key: 'asc' },
    });
    expect(roles.map((role) => role.key)).toEqual(['admin', 'instructor', 'student']);
    for (const role of roles) {
      const key = role.key as keyof typeof SYSTEM_ROLES;
      expect(role.isSystem).toBe(true);
      expect(role.rolePermissions.map((grant) => grant.permissionKey).sort()).toEqual(
        [...SYSTEM_ROLES[key].permissions].sort(),
      );
    }

    const admin = await dbs.owner.user.findUniqueOrThrow({
      where: { id: provisioned.admin.id },
      include: { userRoles: { include: { role: true } } },
    });
    expect(admin.status).toBe('active');
    expect(admin.userRoles.map((grant) => grant.role.key)).toEqual(['admin']);
    expect(await verifyPassword(admin.passwordHash!, 'test-password-1234')).toBe(true);

    const audit = await dbs.owner.auditLog.findFirstOrThrow({
      where: { tenantId, action: 'tenant.provisioned' },
    });
    expect(audit).toMatchObject({
      actorType: 'system',
      resourceType: 'tenant',
      resourceId: tenantId,
    });
  });

  it('creates a password-less admin as invited', async () => {
    const slug = `invited-${randomUUID().slice(0, 8)}`;
    const { admin } = await provisionTenant(dbs.owner, {
      slug,
      name: 'Invited Admin School',
      admin: { email: `Admin@${slug}.test`, name: 'Pending Admin' },
    });

    expect(admin).toMatchObject({
      status: 'invited',
      passwordHash: null,
      email: `admin@${slug}.test`,
    });
  });

  it('rejects a duplicate slug', async () => {
    const existing = await createTestTenant(dbs.owner, 'dupe');

    const duplicate = provisionTenant(dbs.owner, {
      slug: existing.tenant.slug,
      name: 'Imposter',
      admin: { email: 'x@example.test', name: 'X' },
    });

    await expect(duplicate).rejects.toMatchObject({ code: 'P2002' });
  });

  it('validates slugs in code, with a database CHECK as the backstop', async () => {
    await expect(
      provisionTenant(dbs.owner, {
        slug: 'Not A Slug',
        name: 'Bad',
        admin: { email: 'a@b.test', name: 'A' },
      }),
    ).rejects.toBeInstanceOf(ZodError);

    const direct = dbs.owner.$executeRaw`
      INSERT INTO tenants (id, slug, name, updated_at) VALUES (gen_random_uuid(), 'Not A Slug', 'Bad', now())`;
    await expect(direct).rejects.toThrow(/tenants_slug_format/);
  });
});

describe('demo seed', () => {
  let dbs: TestDatabases;

  beforeAll(() => {
    dbs = connectTestDatabases();
  });

  afterAll(async () => {
    await dbs.close();
  });

  it('creates both demo schools once and is idempotent', async () => {
    expect(await seedDemoTenants(dbs.owner)).toEqual([
      { slug: 'lincoln', created: true },
      { slug: 'riverside', created: true },
    ]);
    expect(await seedDemoTenants(dbs.owner)).toEqual([
      { slug: 'lincoln', created: false },
      { slug: 'riverside', created: false },
    ]);
  });

  it('keeps each seeded school’s data isolated when read through TenantDb', async () => {
    const lincoln = await dbs.owner.tenant.findUniqueOrThrow({ where: { slug: 'lincoln' } });

    const [users, courses, crossTenantUsers] = await runAsTenant(lincoln.id, () =>
      Promise.all([
        dbs.db.client.user.count(),
        dbs.db.client.course.findMany({ orderBy: { code: 'asc' } }),
        dbs.db.client.user.count({ where: { email: { endsWith: '@riverside.test' } } }),
      ]),
    );

    expect(users).toBe(9);
    expect(courses.map((course) => course.code)).toEqual(['ALG-1', 'ART-2', 'BIO-1', 'CS-101']);
    expect(crossTenantUsers).toBe(0);
  });

  it('keeps each section’s enrolled_count in step with its enrollments', async () => {
    const sections = await dbs.owner.section.findMany({
      where: { tenant: { slug: { in: ['lincoln', 'riverside'] } } },
      include: { _count: { select: { enrollments: true } } },
    });

    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) expect(section.enrolledCount).toBe(section._count.enrollments);
  });
});
