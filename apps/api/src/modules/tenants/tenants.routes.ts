import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { NotFoundError } from '../../lib/errors.js';
import { brandingSchema, featuresSchema } from './settings.js';
import type { TenantsService, TenantView } from './tenants.service.js';

export interface TenantRoutesOptions {
  tenants: TenantsService;
  env: Env;
}

const tenantSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  settings: z.object({ branding: brandingSchema, features: featuresSchema }),
  createdAt: z.iso.datetime(),
});

const toResponse = (tenant: TenantView) => ({
  id: tenant.id,
  slug: tenant.slug,
  name: tenant.name,
  status: tenant.status,
  settings: tenant.settings,
  createdAt: tenant.createdAt.toISOString(),
});

export const tenantRoutes: FastifyPluginAsyncZod<TenantRoutesOptions> = async (
  app,
  { tenants, env },
) => {
  const tags = ['tenants'];

  app.get(
    '/current',
    {
      config: { permissions: ['tenant:read'] },
      schema: {
        tags,
        summary: 'The current school and its settings',
        response: { 200: tenantSchema },
      },
    },
    async () => toResponse(await tenants.current()),
  );

  app.patch(
    '/current',
    {
      config: { permissions: ['tenant:update'] },
      schema: {
        tags,
        summary: 'Update the school name, branding or features',
        body: z
          .object({
            name: z.string().trim().min(1).max(200).optional(),
            branding: brandingSchema.optional(),
            features: featuresSchema.partial().optional(),
          })
          .refine((body) => Object.keys(body).length > 0, 'Nothing to update.'),
        response: { 200: tenantSchema },
      },
    },
    async (request) => toResponse(await tenants.update(request.body)),
  );

  app.get(
    '/by-slug/:slug',
    {
      config: {
        auth: 'public',
        rateLimit: { max: env.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
      },
      schema: {
        tags,
        summary: 'Public profile of a school, for its login page (branding, SSO availability)',
        params: z.object({ slug: z.string().min(1).max(63) }),
        response: {
          200: z.object({
            id: z.uuid(),
            slug: z.string(),
            name: z.string(),
            branding: brandingSchema,
            sso: z.object({ enabled: z.boolean(), displayName: z.string().nullable() }),
          }),
        },
      },
    },
    async (request) => {
      const profile = await tenants.publicProfile(request.params.slug);
      if (!profile) throw new NotFoundError('School not found.');
      return profile;
    },
  );
};
