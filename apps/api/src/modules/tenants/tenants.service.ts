import { runAsTenant } from '../../context/request-context.js';
import { requireTenantId } from '../../db/scope.js';
import type { TenantDb } from '../../db/tenant-db.js';
import type { TenantDirectory } from '../../db/tenant-directory.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditLogger } from '../audit/audit.service.js';
import { oidcConfigSchema } from '../auth/oidc/oidc.config.js';
import { readSettings, type Branding, type Features, type TenantSettings } from './settings.js';

export interface TenantView {
  id: string;
  slug: string;
  name: string;
  status: string;
  settings: TenantSettings;
  createdAt: Date;
}

export interface PublicTenantProfile {
  id: string;
  slug: string;
  name: string;
  branding: Branding;
  sso: { enabled: boolean; displayName: string | null };
}

export class TenantsService {
  constructor(
    private readonly deps: { db: TenantDb; directory: TenantDirectory; audit: AuditLogger },
  ) {}

  async current(): Promise<TenantView> {
    const tenant = await this.deps.db.client.tenant.findUniqueOrThrow({
      where: { id: requireTenantId('Reading the school') },
    });
    return { ...tenant, settings: readSettings(tenant.settings) };
  }

  /** Features of the current school (for services that gate behaviour on them). */
  async features(): Promise<Features> {
    return (await this.current()).settings.features;
  }

  async update(input: {
    name?: string | undefined;
    branding?: Branding | undefined;
    features?: Partial<Features> | undefined;
  }): Promise<TenantView> {
    return this.deps.db.transaction(async (tx) => {
      const before = await this.current();
      const settings: TenantSettings = {
        branding: input.branding
          ? { ...before.settings.branding, ...input.branding }
          : before.settings.branding,
        features: { ...before.settings.features, ...input.features },
      };
      const updated = await tx.tenant.update({
        where: { id: before.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          settings: settings as unknown as Prisma.InputJsonObject,
        },
      });
      await this.deps.audit.record({
        action: 'tenant.updated',
        resourceType: 'tenant',
        resourceId: updated.id,
        metadata: {
          changed: Object.keys(input).filter(
            (key) => input[key as keyof typeof input] !== undefined,
          ),
          ...(input.features ? { features: input.features } : {}),
        },
      });
      return { ...updated, settings };
    });
  }

  /** What an unauthenticated login page may show about a school. */
  async publicProfile(slug: string): Promise<PublicTenantProfile | null> {
    const tenant = await this.deps.directory.resolveBySlug(slug);
    if (tenant?.status !== 'active') return null;
    const sso = await runAsTenant(tenant.id, async () => {
      const integration = await this.deps.db.client.integration.findUnique({
        where: { tenantId_provider: { tenantId: tenant.id, provider: 'oidc' } },
        select: { status: true, config: true },
      });
      const config = oidcConfigSchema.safeParse(integration?.config);
      return integration?.status === 'connected' && config.success
        ? { enabled: true, displayName: config.data.displayName }
        : { enabled: false, displayName: null };
    });
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      branding: readSettings({ branding: tenant.branding }).branding,
      sso,
    };
  }
}
