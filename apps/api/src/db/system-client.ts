import type { Logger } from 'pino';
import { createDatabase } from './prisma.js';

/**
 * Cross-tenant database access as `cb_system`, whose row-level security policy admits every
 * tenant. It exists only for infrastructure that must look across tenants to *discover* work
 * (the outbox relay, payment reconciliation, expiry sweeps); the work itself then runs under a
 * tenant context like everything else.
 *
 * Import restrictions are enforced by ESLint (see eslint.config.js): feature modules and the
 * HTTP layer cannot reach this file, so the API process holds no cross-tenant credentials.
 */
export function createSystemDatabase(url: string, logger: Logger) {
  return createDatabase({ url, poolMax: 2, applicationName: 'campusbridge-system' }, logger);
}
