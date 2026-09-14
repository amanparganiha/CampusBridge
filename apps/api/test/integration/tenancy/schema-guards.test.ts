import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../../src/authz/permissions.js';
import { TENANT_SCOPED_TABLES } from '../../../src/db/tenant-models.js';
import {
  asRuntimeRole,
  connectTestDatabases,
  createTestTenant,
  type TestDatabases,
} from '../helpers/database.js';

/**
 * Structural guarantees, checked against the live catalog after migrations. These are the tests
 * that fail when someone adds a tenant-owned table and forgets its policies, a global unique
 * index, or a single-column foreign key: mistakes code review easily misses.
 */
describe('schema guards', () => {
  let dbs: TestDatabases;
  let tenantTables: string[];

  const catalog = <T>(sql: string, ...params: unknown[]) =>
    dbs.owner.$queryRawUnsafe<T[]>(sql, ...params);

  beforeAll(async () => {
    dbs = connectTestDatabases();
    const rows = await catalog<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
        ORDER BY 1`,
    );
    tenantTables = rows.map((row) => row.table_name);
  });

  afterAll(async () => {
    await dbs.close();
  });

  it('knows every tenant-owned table (the extension scopes exactly these)', () => {
    expect(tenantTables).toEqual(Object.keys(TENANT_SCOPED_TABLES).sort());
  });

  it('enables row-level security on every tenant-owned table and on tenants', async () => {
    const rows = await catalog<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])`,
      [...tenantTables, 'tenants'],
    );

    expect(rows).toHaveLength(tenantTables.length + 1);
    expect(rows.filter((row) => !row.relrowsecurity).map((row) => row.relname)).toEqual([]);
  });

  it('gives the runtime role exactly one policy per tenant table: the tenant filter', async () => {
    const policies = await catalog<{
      tablename: string;
      policyname: string;
      roles: string[];
      cmd: string;
      qual: string;
      with_check: string;
    }>(
      `SELECT tablename, policyname, roles::text[] AS roles, cmd, qual, with_check
         FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      tenantTables,
    );

    for (const table of tenantTables) {
      const forTable = policies.filter((policy) => policy.tablename === table);
      // Permissive policies are OR-ed together, so any extra policy reaching cb_app_rw (or
      // PUBLIC) could widen access. There must be exactly the tenant filter and the relay's.
      expect(forTable.map((policy) => policy.roles.join(',')).sort(), table).toEqual([
        'cb_app_rw',
        'cb_system_rw',
      ]);

      const isolation = forTable.find((policy) => policy.roles.includes('cb_app_rw'))!;
      expect(isolation, table).toMatchObject({
        policyname: 'tenant_isolation',
        cmd: 'ALL',
        qual: '(tenant_id = app.current_tenant_id())',
        with_check: '(tenant_id = app.current_tenant_id())',
      });
    }
  });

  it('includes tenant_id in every unique constraint, so uniqueness never leaks across tenants', async () => {
    const indexes = await catalog<{
      table: string;
      index: string;
      primary: boolean;
      columns: string[];
    }>(
      `SELECT t.relname AS table, i.relname AS index, ix.indisprimary AS primary,
              array_agg(a.attname::text ORDER BY a.attnum) AS columns
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE ix.indisunique AND t.relnamespace = 'public'::regnamespace AND t.relname = ANY($1::text[])
        GROUP BY t.relname, i.relname, ix.indisprimary`,
      tenantTables,
    );

    // Surrogate UUIDv7 primary keys are the only global uniques: never client-chosen.
    const offenders = indexes.filter(
      (index) =>
        !index.columns.includes('tenant_id') && !(index.primary && index.columns.join() === 'id'),
    );
    expect(offenders).toEqual([]);
  });

  it('uses composite (tenant_id, ...) foreign keys between tenant-owned tables', async () => {
    const foreignKeys = await catalog<{
      name: string;
      source: string;
      target: string;
      columns: string[];
    }>(
      `SELECT con.conname AS name, src.relname AS source, tgt.relname AS target,
              ARRAY(SELECT attname::text FROM pg_attribute
                     WHERE attrelid = con.conrelid AND attnum = ANY(con.conkey)) AS columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_class tgt ON tgt.oid = con.confrelid
        WHERE con.contype = 'f' AND src.relnamespace = 'public'::regnamespace`,
    );
    const betweenTenantTables = foreignKeys.filter(
      (fk) => tenantTables.includes(fk.source) && tenantTables.includes(fk.target),
    );

    expect(betweenTenantTables.length).toBeGreaterThan(10);
    expect(betweenTenantTables.filter((fk) => !fk.columns.includes('tenant_id'))).toEqual([]);
  });

  it('keeps the runtime roles unprivileged: no superuser, no BYPASSRLS, no table ownership', async () => {
    const roles = await catalog<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
        WHERE rolname IN ('cb_app', 'cb_system', 'cb_app_rw', 'cb_system_rw') ORDER BY 1`,
    );
    expect(roles).toEqual([
      { rolname: 'cb_app', rolsuper: false, rolbypassrls: false },
      { rolname: 'cb_app_rw', rolsuper: false, rolbypassrls: false },
      { rolname: 'cb_system', rolsuper: false, rolbypassrls: false },
      { rolname: 'cb_system_rw', rolsuper: false, rolbypassrls: false },
    ]);

    const owned = await catalog<{ count: bigint }>(
      `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'
          AND tableowner IN ('cb_app', 'cb_system', 'cb_app_rw', 'cb_system_rw')`,
    );
    expect(Number(owned[0]!.count)).toBe(0);
  });

  it.each([
    ['audit_logs', 'SELECT', true],
    ['audit_logs', 'INSERT', true],
    ['audit_logs', 'UPDATE', false],
    ['audit_logs', 'DELETE', false],
    ['tenants', 'SELECT', true],
    ['tenants', 'UPDATE', true],
    ['tenants', 'INSERT', false],
    ['tenants', 'DELETE', false],
    ['permissions', 'SELECT', true],
    ['permissions', 'INSERT', false],
    ['permissions', 'UPDATE', false],
    ['permissions', 'DELETE', false],
  ])('grants cb_app %s %s = %s', async (table, privilege, expected) => {
    const rows = await catalog<{ allowed: boolean }>(
      'SELECT has_table_privilege($1, $2, $3) AS allowed',
      'cb_app',
      table,
      privilege,
    );

    expect(rows[0]!.allowed).toBe(expected);
  });

  it('makes audit logs append-only for the runtime role, even for its own tenant', async () => {
    const tenant = await createTestTenant(dbs.owner, 'audit');

    const tamper = asRuntimeRole(dbs.appPool, tenant.tenant.id, (client) =>
      client.query("UPDATE audit_logs SET action = 'tenant.never_happened'"),
    );

    await expect(tamper).rejects.toMatchObject({ code: '42501' });
  });

  it('declares the tenant function STABLE so the planner can use tenant_id indexes', async () => {
    const rows = await catalog<{ provolatile: string }>(
      // provolatile is Postgres's internal "char" type, which Prisma cannot decode; cast it.
      "SELECT provolatile::text AS provolatile FROM pg_proc WHERE proname = 'current_tenant_id' AND pronamespace = 'app'::regnamespace",
    );

    expect(rows).toEqual([{ provolatile: 's' }]);
  });

  it('pins search_path on the SECURITY DEFINER slug lookup', async () => {
    const rows = await catalog<{ prosecdef: boolean; proconfig: string[] }>(
      "SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'resolve_tenant' AND pronamespace = 'app'::regnamespace",
    );

    expect(rows).toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog, public'] }]);
  });

  it('mirrors the code permission catalog in the database', async () => {
    const rows = await catalog<{ key: string; description: string }>(
      'SELECT key, description FROM permissions ORDER BY key',
    );

    expect(Object.fromEntries(rows.map((row) => [row.key, row.description]))).toEqual(PERMISSIONS);
  });
});
