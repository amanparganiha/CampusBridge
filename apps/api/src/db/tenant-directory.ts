import type { PrismaClient, TenantStatus } from '../generated/prisma/client.js';

export interface PublicTenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  branding: Record<string, unknown>;
}

/**
 * Resolves a school by its public slug before anyone is authenticated (login, SSO start, the
 * login page's branding). Goes through the app.resolve_tenant() SECURITY DEFINER function, the
 * only way the runtime role can read a tenant row without already being in that tenant: one
 * exact slug at a time, public fields only, never a list.
 */
export class TenantDirectory {
  constructor(private readonly prisma: PrismaClient) {}

  async resolveBySlug(slug: string): Promise<PublicTenant | null> {
    const rows = await this.prisma.$queryRaw<PublicTenant[]>`
      SELECT id::text AS id, slug, name, status::text AS status, branding
      FROM app.resolve_tenant(${slug})`;
    return rows[0] ?? null;
  }
}
