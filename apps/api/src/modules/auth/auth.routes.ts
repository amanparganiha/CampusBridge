import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePrincipal, requireUserPrincipal } from '../../auth/authenticate.js';
import type { Env } from '../../config/env.js';
import { AppError, BadRequestError, ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import type { AuthService } from './auth.service.js';
import {
  clearRefreshCookie,
  refreshCookieName,
  secureCookies,
  setRefreshCookie,
} from './refresh-cookie.js';
import {
  sessionResponseSchema,
  tokenDeliverySchema,
  toSessionResponse,
} from './session-response.js';

export interface AuthRoutesOptions {
  auth: AuthService;
  env: Env;
}

const tokenDelivery = tokenDeliverySchema;
const sessionResponse = sessionResponseSchema;

const meResponse = z.object({
  kind: z.enum(['user', 'api_key']),
  user: z.object({ id: z.uuid(), email: z.string(), name: z.string() }).optional(),
  apiKey: z.object({ id: z.uuid(), name: z.string() }).optional(),
  tenant: z.object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    branding: z.record(z.string(), z.unknown()),
  }),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});

/**
 * Cookie-authenticated endpoints additionally require a custom header. Cross-site forms cannot
 * set one, and cross-site fetches with one need a CORS preflight, which this API refuses: CSRF
 * protection in depth alongside SameSite=Strict.
 */
function requireCsrfHeader(request: FastifyRequest): void {
  if (request.headers['x-csrf-protection'] === undefined) {
    throw new ForbiddenError('Cookie-based requests must send the X-CSRF-Protection header.', {
      code: 'CSRF_HEADER_REQUIRED',
    });
  }
}

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (app, { auth, env }) => {
  const secure = secureCookies(env);
  const throttled = { rateLimit: { max: env.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } };
  const tags = ['auth'];

  /** Where the refresh token comes from: the body (API clients) or the school's cookie (browsers). */
  const readRefreshToken = (
    request: FastifyRequest,
    body: { refreshToken?: string | undefined; tenantId?: string | undefined },
  ): { token: string | undefined; delivery: z.infer<typeof tokenDelivery> } => {
    if (body.refreshToken) return { token: body.refreshToken, delivery: 'body' };
    if (!body.tenantId) {
      throw new BadRequestError('Send refreshToken, or tenantId to use the refresh cookie.', {
        code: 'REFRESH_TOKEN_REQUIRED',
      });
    }
    requireCsrfHeader(request);
    return { token: request.cookies[refreshCookieName(body.tenantId)], delivery: 'cookie' };
  };

  app.post(
    '/login',
    {
      config: { auth: 'public', ...throttled },
      schema: {
        tags,
        summary: 'Sign in with email and password',
        body: z.object({
          tenant: z.string().min(1).max(63).describe('The school slug, e.g. "lincoln".'),
          email: z.email().max(320),
          password: z.string().min(1).max(1024),
          tokenDelivery: tokenDelivery.default('cookie'),
        }),
        response: { 200: sessionResponse },
      },
    },
    async (request, reply) => {
      const { tenant, email, password, tokenDelivery: delivery } = request.body;
      const session = await auth.login({ tenantSlug: tenant, email, password });
      if (delivery === 'cookie') setRefreshCookie(reply, session, secure);
      return toSessionResponse(session, delivery);
    },
  );

  app.post(
    '/refresh',
    {
      config: { auth: 'public', ...throttled },
      schema: {
        tags,
        summary: 'Rotate the refresh token and get a new access token',
        description:
          'Each refresh token works once. Presenting a rotated token again revokes the whole session.',
        body: z.object({
          refreshToken: z.string().max(256).optional(),
          tenantId: z
            .uuid()
            .optional()
            .describe('With the refresh cookie: which school to refresh.'),
        }),
        response: { 200: sessionResponse },
      },
    },
    async (request, reply) => {
      const { token, delivery } = readRefreshToken(request, request.body);
      if (!token) {
        throw new UnauthorizedError('No refresh token for this school. Sign in again.', {
          code: 'INVALID_REFRESH_TOKEN',
        });
      }
      try {
        const session = await auth.refresh(token);
        if (delivery === 'cookie') setRefreshCookie(reply, session, secure);
        return toSessionResponse(session, delivery);
      } catch (error) {
        // A dead refresh cookie is useless to the browser: drop it along with the error.
        if (
          delivery === 'cookie' &&
          request.body.tenantId &&
          error instanceof AppError &&
          error.status === 401
        ) {
          clearRefreshCookie(reply, request.body.tenantId, secure);
        }
        throw error;
      }
    },
  );

  app.post(
    '/logout',
    {
      config: { auth: 'optional' },
      schema: {
        tags,
        summary: 'End the current session',
        description:
          'Uses the access token if present, otherwise the refresh token. Always succeeds.',
        // Fastify passes `null` when there is no body at all.
        body: z
          .object({ refreshToken: z.string().max(256).optional(), tenantId: z.uuid().optional() })
          .nullish(),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const { principal } = request;
      if (principal?.kind === 'user') {
        await auth.logout(principal);
        clearRefreshCookie(reply, principal.tenantId, secure);
      } else if (request.body?.refreshToken || request.body?.tenantId) {
        const { token } = readRefreshToken(request, request.body);
        if (token) await auth.logoutWithRefreshToken(token);
        if (request.body.tenantId) clearRefreshCookie(reply, request.body.tenantId, secure);
      }
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/logout-all',
    {
      schema: {
        tags,
        summary: 'End every session of the current user at this school',
        response: { 200: z.object({ sessionsRevoked: z.number().int() }) },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request);
      const sessionsRevoked = await auth.logoutAll(principal);
      clearRefreshCookie(reply, principal.tenantId, secure);
      return { sessionsRevoked };
    },
  );

  app.get(
    '/me',
    {
      schema: {
        tags,
        summary: 'The authenticated user (or API key), school, roles and permissions',
        response: { 200: meResponse },
      },
    },
    async (request) => auth.describe(requirePrincipal(request)),
  );
};
