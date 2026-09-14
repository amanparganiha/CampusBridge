import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env files. For local work, read the monorepo's root .env; values
// already present in the environment (CI, ECS task definitions) always win.
const rootEnvFile = new URL('../../.env', import.meta.url);
if (existsSync(rootEnvFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(rootEnvFile, 'utf8')))) {
    process.env[key] ??= value;
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Migrations run as the schema owner, never as the least-privileged runtime role.
    // Plain process.env (not Prisma's env() helper, which throws when unset) so that
    // `prisma generate` works in CI and Docker builds where no database is configured.
    url: process.env.MIGRATE_DATABASE_URL,
  },
});
