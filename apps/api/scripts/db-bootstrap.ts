/**
 * Creates or updates the application's LOGIN roles (see src/db/bootstrap.ts).
 * Runs after migrations: `npm run db:setup`.
 */
import { bootstrapLoginRoles } from '../src/db/bootstrap.js';

const ownerUrl = process.env.MIGRATE_DATABASE_URL;

try {
  if (!ownerUrl) throw new Error('MIGRATE_DATABASE_URL is required');
  const outcomes = await bootstrapLoginRoles({
    ownerUrl,
    appUrl: process.env.DATABASE_URL,
    systemUrl: process.env.SYSTEM_DATABASE_URL,
  });
  for (const outcome of outcomes) console.log(`db-bootstrap: ${outcome}`);
} catch (error) {
  console.error('db-bootstrap failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
