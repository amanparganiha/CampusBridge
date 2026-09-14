import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Env } from '../../../config/env.js';
import { secureCookies, setRefreshCookie } from '../refresh-cookie.js';
import { OidcLoginError, type OidcService } from './oidc.service.js';

export interface OidcRoutesOptions {
  oidc: OidcService;
  env: Env;
  redirectUri: string;
}

/** Only same-site relative paths: never an absolute or protocol-relative URL (open redirect). */
function safeReturnTo(value: string | undefined): string {
  return value && /^\/(?![/\\])[^\s]{0,511}$/.test(value) ? value : '/';
}

export const oidcRoutes: FastifyPluginAsyncZod<OidcRoutesOptions> = async (
  app,
  { oidc, env, redirectUri },
) => {
  const secure = secureCookies(env);
  const throttled = { rateLimit: { max: env.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } };
  const tags = ['auth'];

  const loginPage = (error: string, tenantSlug?: string) => {
    const url = new URL('/login', env.ADMIN_URL);
    url.searchParams.set('error', error);
    if (tenantSlug) url.searchParams.set('tenant', tenantSlug);
    return url.href;
  };

  app.get(
    '/:tenantSlug/authorize',
    {
      config: { auth: 'public', ...throttled },
      schema: {
        tags,
        summary: 'Start single sign-on with the school’s identity provider',
        params: z.object({ tenantSlug: z.string().min(1).max(63) }),
        querystring: z.object({ returnTo: z.string().max(512).optional() }),
        response: { 302: z.null() },
      },
    },
    async (request, reply) => {
      const { tenantSlug } = request.params;
      try {
        const url = await oidc.beginLogin(tenantSlug, safeReturnTo(request.query.returnTo));
        return await reply.redirect(url.href, 302);
      } catch (error) {
        if (error instanceof OidcLoginError)
          return reply.redirect(loginPage(error.code, tenantSlug), 302);
        throw error;
      }
    },
  );

  app.get(
    '/callback',
    {
      config: { auth: 'public', ...throttled },
      schema: {
        tags,
        summary: 'Identity provider redirect target (not called directly)',
        querystring: z.looseObject({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
        response: { 302: z.null() },
      },
    },
    async (request, reply) => {
      // The user cancelled or the IdP refused: clear the pending login and go back.
      if (request.query.error) {
        const tenantSlug = await oidc.discardLogin(request.query.state);
        return reply.redirect(loginPage('idp_denied', tenantSlug), 302);
      }

      // Rebuild the callback URL from configuration, never from the Host header.
      const callbackUrl = new URL(redirectUri);
      callbackUrl.search = new URL(request.url, 'http://placeholder').search;

      try {
        const { session, tenantSlug, returnTo } = await oidc.completeLogin(callbackUrl);
        setRefreshCookie(reply, session, secure);
        const landing = new URL('/auth/callback', env.ADMIN_URL);
        landing.searchParams.set('tenant', tenantSlug);
        landing.searchParams.set('returnTo', returnTo);
        return await reply.redirect(landing.href, 302);
      } catch (error) {
        if (error instanceof OidcLoginError) return reply.redirect(loginPage(error.code), 302);
        throw error;
      }
    },
  );
};
