import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePrincipal } from '../../auth/authenticate.js';
import { sortQuerySchema } from '../../lib/keyset.js';
import { pageSchema, paginationQuerySchema } from '../../lib/pagination.js';
import type { InvitationsService, InvitationView } from './invitations.service.js';
import { USER_SORT_FIELDS, type UsersService, type UserView } from './users.service.js';

export interface UserRoutesOptions {
  users: UsersService;
  invitations: InvitationsService;
}

const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  status: z.enum(['invited', 'active', 'suspended']),
  roles: z.array(z.string()),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.object({ key: z.string(), name: z.string() }),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

const toUser = (user: UserView) => ({
  ...user,
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  createdAt: user.createdAt.toISOString(),
});

export const toInvitation = (invitation: InvitationView) => ({
  ...invitation,
  expiresAt: invitation.expiresAt.toISOString(),
  acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
  createdAt: invitation.createdAt.toISOString(),
});

const idParams = z.object({ id: z.uuid() });

export const userRoutes: FastifyPluginAsyncZod<UserRoutesOptions> = async (
  app,
  { users, invitations },
) => {
  const tags = ['users'];

  app.get(
    '/',
    {
      config: { permissions: ['user:read'] },
      schema: {
        tags,
        summary: 'List users at this school',
        querystring: paginationQuerySchema.extend({
          sort: sortQuerySchema(USER_SORT_FIELDS, 'name'),
          role: z.string().max(40).optional(),
          status: z.enum(['invited', 'active', 'suspended']).optional(),
          q: z.string().trim().min(1).max(100).optional().describe('Matches name or email.'),
        }),
        response: { 200: pageSchema(userSchema) },
      },
    },
    async (request) => {
      const page = await users.list(request.query);
      return { data: page.data.map(toUser), pageInfo: page.pageInfo };
    },
  );

  app.get(
    '/:id',
    {
      config: { permissions: ['user:read'] },
      schema: { tags, summary: 'Get a user', params: idParams, response: { 200: userSchema } },
    },
    async (request) => toUser(await users.get(request.params.id)),
  );

  app.patch(
    '/:id',
    {
      config: { permissions: ['user:update'] },
      schema: {
        tags,
        summary: 'Rename, suspend or reactivate a user',
        description: 'Suspending a user ends all of their sessions immediately.',
        params: idParams,
        body: z
          .object({
            name: z.string().trim().min(1).max(200).optional(),
            status: z.enum(['active', 'suspended']).optional(),
          })
          .refine(
            (body) => body.name !== undefined || body.status !== undefined,
            'Nothing to update.',
          ),
        response: { 200: userSchema },
      },
    },
    async (request) =>
      toUser(await users.update(requirePrincipal(request), request.params.id, request.body)),
  );

  app.put(
    '/:id/roles',
    {
      config: { permissions: ['role:assign'] },
      schema: {
        tags,
        summary: "Replace a user's roles",
        description:
          'You can only grant or remove roles whose permissions you hold. Removing a role ends the ' +
          "user's sessions so it takes effect immediately.",
        params: idParams,
        body: z.object({ roles: z.array(z.string().min(1).max(40)).min(1).max(20) }),
        response: { 200: userSchema },
      },
    },
    async (request) =>
      toUser(
        await users.setRoles(requirePrincipal(request), request.params.id, request.body.roles),
      ),
  );

  app.post(
    '/invite',
    {
      config: { permissions: ['user:invite'], idempotent: true },
      schema: {
        tags,
        summary: 'Invite someone to the school by email',
        description:
          'Supports the Idempotency-Key header. Re-inviting replaces a pending invitation.',
        body: z.object({ email: z.email().max(320), role: z.string().min(1).max(40) }),
        response: { 201: invitationSchema },
      },
    },
    async (request, reply) => {
      const invitation = await invitations.invite(requirePrincipal(request), {
        email: request.body.email,
        roleKey: request.body.role,
      });
      return reply.status(201).send(toInvitation(invitation));
    },
  );
};

export const roleRoutes: FastifyPluginAsyncZod<{ users: UsersService }> = async (
  app,
  { users },
) => {
  app.get(
    '/',
    {
      config: { permissions: ['role:read'] },
      schema: {
        tags: ['users'],
        summary: 'Roles at this school and the permissions they grant',
        response: {
          200: z.object({
            data: z.array(
              z.object({
                id: z.uuid(),
                key: z.string(),
                name: z.string(),
                description: z.string().nullable(),
                isSystem: z.boolean(),
                permissions: z.array(z.string()),
              }),
            ),
          }),
        },
      },
    },
    async () => ({ data: await users.listRoles() }),
  );
};

export const invitationRoutes: FastifyPluginAsyncZod<{ invitations: InvitationsService }> = async (
  app,
  { invitations },
) => {
  const tags = ['users'];

  app.get(
    '/',
    {
      config: { permissions: ['user:invite'] },
      schema: {
        tags,
        summary: 'Recent invitations and their status',
        response: { 200: z.object({ data: z.array(invitationSchema) }) },
      },
    },
    async () => ({ data: (await invitations.list()).map(toInvitation) }),
  );

  app.delete(
    '/:id',
    {
      config: { permissions: ['user:invite'] },
      schema: {
        tags,
        summary: 'Revoke a pending invitation',
        params: idParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await invitations.revoke(request.params.id);
      return reply.status(204).send(null);
    },
  );
};
