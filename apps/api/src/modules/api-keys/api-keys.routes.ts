import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUserPrincipal } from '../../auth/authenticate.js';
import { ALL_PERMISSIONS, type Permission } from '../../authz/permissions.js';
import type { ApiKeyService, ApiKeyView } from './api-keys.service.js';

export interface ApiKeyRoutesOptions {
  apiKeys: ApiKeyService;
}

const apiKeySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  hint: z.string().describe('Last characters of the key, for telling keys apart.'),
  scopes: z.array(z.string()),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

const toResponse = (key: ApiKeyView) => ({
  ...key,
  createdAt: key.createdAt.toISOString(),
  lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  expiresAt: key.expiresAt?.toISOString() ?? null,
  revokedAt: key.revokedAt?.toISOString() ?? null,
});

const permissionEnum = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);

export const apiKeyRoutes: FastifyPluginAsyncZod<ApiKeyRoutesOptions> = async (
  app,
  { apiKeys },
) => {
  const config = { permissions: ['apikey:manage'] as const };
  const tags = ['api-keys'];

  app.get(
    '/',
    {
      config,
      schema: {
        tags,
        summary: 'List API keys',
        response: { 200: z.object({ data: z.array(apiKeySchema) }) },
      },
    },
    async () => ({ data: (await apiKeys.list()).map(toResponse) }),
  );

  app.post(
    '/',
    {
      config,
      schema: {
        tags,
        summary: 'Create an API key for a partner system',
        description:
          'The key is returned once and stored only as a hash. Scopes cannot exceed your own permissions.',
        body: z.object({
          name: z.string().trim().min(1).max(100),
          scopes: z.array(permissionEnum).min(1),
          expiresAt: z.iso.datetime().optional(),
        }),
        response: { 201: z.object({ apiKey: apiKeySchema, token: z.string() }) },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request);
      const { name, scopes, expiresAt } = request.body;
      const created = await apiKeys.create(principal, {
        name,
        scopes,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      });
      return reply.status(201).send({ apiKey: toResponse(created.apiKey), token: created.token });
    },
  );

  app.delete(
    '/:id',
    {
      config,
      schema: {
        tags,
        summary: 'Revoke an API key',
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await apiKeys.revoke(request.params.id);
      return reply.status(204).send(null);
    },
  );
};
