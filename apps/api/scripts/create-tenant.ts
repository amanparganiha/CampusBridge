/**
 * Provisions a new school (tenant) with its system roles and first administrator.
 *
 *   npm run tenant:create -- --slug lincoln --name "Lincoln High School" \
 *     --admin-email admin@lincoln.edu --admin-name "Pat Admin" [--admin-password ...]
 *
 * Without --admin-password a strong random password is generated and printed once.
 * Runs as the schema owner (MIGRATE_DATABASE_URL); this is deliberately not an API endpoint.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { createDatabase } from '../src/db/prisma.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { provisionTenant } from '../src/modules/tenants/provisioning.js';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-name': { type: 'string' },
    'admin-password': { type: 'string' },
  },
});

const ownerUrl = process.env.MIGRATE_DATABASE_URL;
const { slug, name } = values;
const adminEmail = values['admin-email'];
const adminName = values['admin-name'];

if (!ownerUrl || !slug || !name || !adminEmail || !adminName) {
  console.error(
    'Usage: npm run tenant:create -- --slug <slug> --name <name> --admin-email <email> --admin-name <name> [--admin-password <password>]\n' +
      'MIGRATE_DATABASE_URL must be set.',
  );
  process.exit(1);
}

const generatedPassword = values['admin-password']
  ? undefined
  : randomBytes(18).toString('base64url');
const { pool, prisma } = createDatabase(
  { url: ownerUrl, poolMax: 1, applicationName: 'campusbridge-create-tenant' },
  pino({ level: 'warn' }),
);

try {
  const { tenant, admin } = await provisionTenant(prisma, {
    slug,
    name,
    admin: {
      email: adminEmail,
      name: adminName,
      password: values['admin-password'] ?? generatedPassword,
    },
  });
  console.log(`Created tenant "${tenant.name}" (${tenant.slug}, id ${tenant.id})`);
  console.log(`Administrator: ${admin.email}`);
  if (generatedPassword) console.log(`Generated password (shown once): ${generatedPassword}`);
} catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    console.error(`A tenant with slug "${slug}" already exists.`);
  } else {
    console.error('create-tenant failed:', error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await pool.end();
}
