import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionRevocation } from '../../../src/auth/session-revocation.js';
import { runAsTenant } from '../../../src/context/request-context.js';
import type { ProvisionedTenant } from '../../../src/modules/tenants/provisioning.js';
import { connectTestDatabases, createTestTenant, type TestDatabases } from '../helpers/database.js';

const refused = () => Promise.reject(new Error('connect ECONNREFUSED'));

/** Like ioredis: multi() returns a chainable pipeline synchronously; exec() is what fails. */
function failingPipeline(): unknown {
  const pipeline: unknown = new Proxy(
    {},
    { get: (_target, property) => (property === 'exec' ? refused : () => pipeline) },
  );
  return pipeline;
}

/** A Redis whose every command fails, as during an ElastiCache failover. */
const unavailableRedis = new Proxy({} as Redis, {
  get: (_target, property) => (property === 'multi' ? failingPipeline : refused),
});

describe('session revocation without Redis', () => {
  let dbs: TestDatabases;
  let school: ProvisionedTenant;

  beforeAll(async () => {
    dbs = connectTestDatabases();
    school = await createTestTenant(dbs.owner, 'revocation');
  });

  afterAll(async () => {
    await dbs.close();
  });

  it('falls back to the sessions table, so a revoked session is never accepted', async () => {
    const revocation = new SessionRevocation(
      unavailableRedis,
      dbs.db,
      pino({ level: 'silent' }),
      900,
    );
    const base = {
      tenantId: school.tenant.id,
      userId: school.admin.id,
      authMethod: 'password' as const,
    };
    const inAnHour = new Date(Date.now() + 3_600_000);
    const [active, revoked, expired] = await Promise.all([
      dbs.owner.session.create({ data: { ...base, expiresAt: inAnHour } }),
      dbs.owner.session.create({ data: { ...base, expiresAt: inAnHour, revokedAt: new Date() } }),
      dbs.owner.session.create({ data: { ...base, expiresAt: new Date(Date.now() - 1000) } }),
    ]);

    await runAsTenant(school.tenant.id, async () => {
      await expect(revocation.isRevoked(active.id)).resolves.toBe(false);
      await expect(revocation.isRevoked(revoked.id)).resolves.toBe(true);
      await expect(revocation.isRevoked(expired.id)).resolves.toBe(true);
      await expect(revocation.isRevoked(crypto.randomUUID())).resolves.toBe(true);
      // Recording a revocation must not throw either: the database is the source of truth.
      await expect(revocation.markRevoked([active.id])).resolves.toBeUndefined();
    });
  });
});
