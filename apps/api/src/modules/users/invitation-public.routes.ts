import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { secureCookies, setRefreshCookie } from '../auth/refresh-cookie.js';
import {
  sessionResponseSchema,
  tokenDeliverySchema,
  toSessionResponse,
} from '../auth/session-response.js';
import type { InvitationsService } from './invitations.service.js';

export interface InvitationPublicRoutesOptions {
  invitations: InvitationsService;
  env: Env;
}

/** NIST SP 800-63B: favour length over composition rules; cap to bound hashing cost. */
const passwordSchema = z.string().min(12, 'Use at least 12 characters.').max(256);

/**
 * The invitation link's endpoints. Tokens travel in POST bodies, never in URLs, so they do not end
 * up in access logs, browser history or Referer headers.
 */
export const invitationPublicRoutes: FastifyPluginAsyncZod<InvitationPublicRoutesOptions> = async (
  app,
  { invitations, env },
) => {
  const tags = ['auth'];
  const throttled = {
    auth: 'public' as const,
    rateLimit: { max: env.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
  };
  const tokenSchema = z.string().min(1).max(256);

  app.post(
    '/lookup',
    {
      config: throttled,
      schema: {
        tags,
        summary: 'Describe an invitation (school, email, role) before accepting it',
        body: z.object({ token: tokenSchema }),
        response: {
          200: z.object({
            tenant: z.object({ name: z.string(), slug: z.string() }),
            email: z.string(),
            role: z.object({ key: z.string(), name: z.string() }),
            expiresAt: z.iso.datetime(),
          }),
        },
      },
    },
    async (request) => {
      const invitation = await invitations.lookup(request.body.token);
      return { ...invitation, expiresAt: invitation.expiresAt.toISOString() };
    },
  );

  app.post(
    '/accept',
    {
      config: throttled,
      schema: {
        tags,
        summary: 'Accept an invitation: create the account and sign in',
        body: z.object({
          token: tokenSchema,
          name: z.string().trim().min(1).max(200),
          password: passwordSchema,
          tokenDelivery: tokenDeliverySchema.default('cookie'),
        }),
        response: { 200: sessionResponseSchema },
      },
    },
    async (request, reply) => {
      const { token, name, password, tokenDelivery } = request.body;
      const session = await invitations.accept(token, { name, password });
      if (tokenDelivery === 'cookie') setRefreshCookie(reply, session, secureCookies(env));
      return toSessionResponse(session, tokenDelivery);
    },
  );
};
