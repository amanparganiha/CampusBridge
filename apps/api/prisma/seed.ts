/**
 * Seeds the two demo schools (see seed-data.ts), including single sign-on through the local
 * Keycloak realms. Idempotent: schools that already exist are skipped. Runs as the schema owner.
 *
 *   npm run db:seed
 */
import { pino } from 'pino';
import { loadSecrets } from '../src/config/secrets.js';
import { createDatabase } from '../src/db/prisma.js';
import { Encryptor } from '../src/lib/crypto/encryption.js';
import { DEMO_PASSWORD } from './seed-data.js';
import { seedDemoTenants } from './seed-demo.js';

const ownerUrl = process.env.MIGRATE_DATABASE_URL;
if (!ownerUrl) {
  console.error('MIGRATE_DATABASE_URL is required');
  process.exit(1);
}

const nodeEnv = process.env.NODE_ENV;
const secrets = await loadSecrets({
  NODE_ENV: nodeEnv === 'production' || nodeEnv === 'test' ? nodeEnv : 'development',
  JWT_PRIVATE_JWKS: process.env.JWT_PRIVATE_JWKS,
  ENCRYPTION_KEYS: process.env.ENCRYPTION_KEYS,
});
const keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';

const { pool, prisma } = createDatabase(
  { url: ownerUrl, poolMax: 2, applicationName: 'campusbridge-seed' },
  pino({ level: 'warn' }),
);

try {
  const outcomes = await seedDemoTenants(prisma, {
    sso: { encryptor: new Encryptor(secrets.encryptionKeys), keycloakUrl },
  });
  for (const { slug, created } of outcomes) {
    console.log(`seed: ${slug} ${created ? 'created' : 'already exists, skipped'}`);
  }
  console.log(`seed: every demo account uses the password "${DEMO_PASSWORD}"`);
  console.log(
    `seed: SSO users (Keycloak at ${keycloakUrl}): sso.teacher@lincoln.test, sso.student@lincoln.test`,
  );
} catch (error) {
  console.error('seed failed:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await pool.end();
}
