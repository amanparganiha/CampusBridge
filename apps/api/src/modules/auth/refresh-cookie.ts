import type { FastifyReply } from 'fastify';
import type { Env } from '../../config/env.js';
import type { IssuedSession } from './auth.service.js';

/**
 * Browsers get the refresh token as an HttpOnly, SameSite=Strict cookie scoped to /api/v1/auth
 * (so it is never sent anywhere else), one per school: the admin app can then hold sessions at
 * several schools at once and switch between them. Script cannot read it, which is the point.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export const refreshCookieName = (tenantId: string) => `cb_rt_${tenantId}`;

export function secureCookies(env: Env): boolean {
  return env.NODE_ENV === 'production' || env.PUBLIC_API_URL.startsWith('https://');
}

export function setRefreshCookie(
  reply: FastifyReply,
  session: IssuedSession,
  secure: boolean,
): void {
  void reply.setCookie(refreshCookieName(session.tenant.id), session.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    expires: session.refreshTokenExpiresAt,
  });
}

export function clearRefreshCookie(reply: FastifyReply, tenantId: string, secure: boolean): void {
  void reply.clearCookie(refreshCookieName(tenantId), {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
}
