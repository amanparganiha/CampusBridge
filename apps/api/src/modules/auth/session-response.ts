import { z } from 'zod';
import type { IssuedSession } from './auth.service.js';

/** How the refresh token is returned: an HttpOnly cookie (browsers) or the body (API clients). */
export const tokenDeliverySchema = z.enum(['cookie', 'body']);
export type TokenDelivery = z.infer<typeof tokenDeliverySchema>;

/** Shared by every endpoint that signs someone in (login, refresh, invitation acceptance). */
export const sessionResponseSchema = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string(),
  expiresIn: z.number().int().describe('Access token lifetime in seconds.'),
  refreshToken: z.string().optional().describe('Only when tokenDelivery is "body".'),
  refreshTokenExpiresAt: z.iso.datetime(),
  user: z.object({ id: z.uuid(), email: z.string(), name: z.string() }),
  tenant: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});

export function toSessionResponse(session: IssuedSession, delivery: TokenDelivery) {
  return {
    tokenType: 'Bearer' as const,
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    ...(delivery === 'body' ? { refreshToken: session.refreshToken } : {}),
    refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString(),
    user: session.user,
    tenant: session.tenant,
    roles: session.roles,
    permissions: session.permissions,
  };
}
