import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import { inject } from 'vitest';
import { createDatabase } from '../../../src/db/prisma.js';
import { createTenantDb, type TenantDb } from '../../../src/db/tenant-db.js';
import type { PrismaClient } from '../../../src/generated/prisma/client.js';
import {
  provisionTenant,
  type ProvisionedTenant,
} from '../../../src/modules/tenants/provisioning.js';

export interface TestDatabases {
  /** Schema owner (superuser in tests): fixtures and assertions that must see everything. */
  owner: PrismaClient;
  /** Runtime role WITHOUT the tenant extension: proves what RLS alone enforces. */
  appRaw: PrismaClient;
  /** Runtime role pool, for raw SQL under RLS. */
  appPool: pg.Pool;
  /** Relay role: cross-tenant via its explicit policy. */
  system: PrismaClient;
  /** What application code uses: runtime role + tenant extension. */
  db: TenantDb;
  close: () => Promise<void>;
}

export function connectTestDatabases(): TestDatabases {
  const { ownerUrl, appUrl, systemUrl } = inject('database');
  const logger = pino({ level: 'silent' });
  const owner = createDatabase(
    { url: ownerUrl, poolMax: 2, applicationName: 'test-owner' },
    logger,
  );
  const app = createDatabase({ url: appUrl, poolMax: 4, applicationName: 'test-app' }, logger);
  const system = createDatabase(
    { url: systemUrl, poolMax: 2, applicationName: 'test-system' },
    logger,
  );

  return {
    owner: owner.prisma,
    appRaw: app.prisma,
    appPool: app.pool,
    system: system.prisma,
    db: createTenantDb(app.prisma),
    close: async () => {
      await Promise.all([
        owner.prisma.$disconnect(),
        app.prisma.$disconnect(),
        system.prisma.$disconnect(),
      ]);
      await Promise.all([owner.pool.end(), app.pool.end(), system.pool.end()]);
    },
  };
}

/** A freshly provisioned school with a unique slug, so test files never collide. */
export function createTestTenant(owner: PrismaClient, label: string): Promise<ProvisionedTenant> {
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  return provisionTenant(owner, {
    slug,
    name: `Test ${label}`,
    admin: { email: `admin@${slug}.test`, name: `${label} admin`, password: 'test-password-1234' },
  });
}

/** A course (with one section) owned by the tenant's admin, created as the owner role. */
export async function createCourseFixture(
  owner: PrismaClient,
  tenant: ProvisionedTenant,
  code = `C-${randomUUID().slice(0, 6).toUpperCase()}`,
) {
  return owner.course.create({
    data: {
      tenantId: tenant.tenant.id,
      code,
      title: `Course ${code}`,
      ownerId: tenant.admin.id,
      status: 'published',
      sections: { create: [{ name: 'Section 1', capacity: 10 }] },
    },
    include: { sections: true },
  });
}

/**
 * Puts at least one row in EVERY tenant-owned table for the tenant, so per-table isolation
 * assertions are never vacuously true on an empty table.
 */
export async function populateEveryTenantTable(
  owner: PrismaClient,
  tenant: ProvisionedTenant,
): Promise<void> {
  const tenantId = tenant.tenant.id;
  const tag = randomUUID().slice(0, 8);
  const course = await createCourseFixture(owner, tenant);
  const section = course.sections[0]!;
  const student = await owner.user.create({
    data: { tenantId, email: `student-${tag}@example.test`, name: 'Student' },
  });
  await owner.userIdentity.create({
    data: { tenantId, userId: student.id, issuer: 'https://idp.example.test', subject: tag },
  });
  const enrollment = await owner.enrollment.create({
    data: { tenantId, sectionId: section.id, studentId: student.id, source: 'admin' },
  });
  await owner.grade.create({
    data: { tenantId, enrollmentId: enrollment.id, title: 'Quiz', score: 8, maxScore: 10 },
  });
  const session = await owner.session.create({
    data: {
      tenantId,
      userId: student.id,
      authMethod: 'password',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await owner.refreshToken.create({
    data: {
      tenantId,
      sessionId: session.id,
      tokenHash: `hash-${tag}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await owner.apiKey.create({
    data: {
      tenantId,
      name: 'Partner',
      prefix: tag,
      keyHash: `key-${tag}`,
      scopes: ['course:read'],
    },
  });
  await owner.invitation.create({
    data: {
      tenantId,
      email: `invitee-${tag}@example.test`,
      roleId: tenant.roleIds.student,
      tokenHash: `invite-${tag}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await owner.outboxEvent.create({
    data: { tenantId, type: 'test.happened', aggregateType: 'test', aggregateId: tag, payload: {} },
  });
  await owner.idempotencyKey.create({
    data: {
      tenantId,
      principalId: student.id,
      key: tag,
      method: 'POST',
      path: '/test',
      requestHash: 'x',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

/**
 * Runs `fn` on a runtime-role connection inside a transaction bound to `tenantId` (or to no
 * tenant when null), then rolls back so tests leave no trace.
 */
export async function asRuntimeRole<T>(
  pool: pg.Pool,
  tenantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
