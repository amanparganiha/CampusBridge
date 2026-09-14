/**
 * Seeds the two demo schools (see seed-data.ts). Idempotent: schools that already exist are
 * skipped. Runs as the schema owner, like provisioning.
 *
 *   npm run db:seed
 */
import { pino } from 'pino';
import { createDatabase } from '../src/db/prisma.js';
import { DEMO_PASSWORD } from './seed-data.js';
import { seedDemoTenants } from './seed-demo.js';

const ownerUrl = process.env.MIGRATE_DATABASE_URL;
if (!ownerUrl) {
  console.error('MIGRATE_DATABASE_URL is required');
  process.exit(1);
}

const { pool, prisma } = createDatabase(
  { url: ownerUrl, poolMax: 2, applicationName: 'campusbridge-seed' },
  pino({ level: 'warn' }),
);

try {
  for (const { slug, created } of await seedDemoTenants(prisma)) {
    console.log(`seed: ${slug} ${created ? 'created' : 'already exists, skipped'}`);
  }
  console.log(`seed: every demo account uses the password "${DEMO_PASSWORD}"`);
} catch (error) {
  console.error('seed failed:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await pool.end();
}
