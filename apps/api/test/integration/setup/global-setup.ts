import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { bootstrapLoginRoles } from '../../../src/db/bootstrap.js';

declare module 'vitest' {
  export interface ProvidedContext {
    database: {
      /** Superuser that owns the schema (runs migrations; bypasses RLS). */
      ownerUrl: string;
      /** Runtime role: DML only, subject to RLS. */
      appUrl: string;
      /** Relay role: cross-tenant via its explicit policy. */
      systemUrl: string;
    };
  }
}

const run = promisify(execFile);
const apiRoot = fileURLToPath(new URL('../../../', import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

function withCredentials(baseUrl: string, username: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

/**
 * One disposable PostgreSQL per test run, migrated with the real `prisma migrate deploy` (the
 * same path production takes) and bootstrapped with the real login roles. Test files share it
 * safely because each creates its own tenants: tenancy itself keeps them apart.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('campusbridge_test')
    .withUsername('campusbridge')
    .withPassword('owner-test-password')
    .start();

  const ownerUrl = container.getConnectionUri();
  const appUrl = withCredentials(ownerUrl, 'cb_app', 'cb-app-test-password');
  const systemUrl = withCredentials(ownerUrl, 'cb_system', 'cb-system-test-password');

  await run(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: apiRoot,
    env: { ...process.env, MIGRATE_DATABASE_URL: ownerUrl },
  });
  await bootstrapLoginRoles({ ownerUrl, appUrl, systemUrl });

  project.provide('database', { ownerUrl, appUrl, systemUrl });

  return async () => {
    await container.stop();
  };
}
