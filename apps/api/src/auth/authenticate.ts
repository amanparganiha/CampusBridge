import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Permission } from '../authz/permissions.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import type { ApiKeyService } from '../modules/api-keys/api-keys.service.js';
import type { AccessTokenService } from './access-tokens.js';
import { parseOpaqueToken } from './opaque-tokens.js';
import type { PermissionResolver } from './permission-resolver.js';
import type { Principal, UserPrincipal } from './principal.js';
import type { SessionRevocation } from './session-revocation.js';
import type { TenantQuota } from './tenant-quota.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Secure by default: omit for routes that require credentials. `public` routes never read
     * credentials (login, refresh, SSO); `optional` routes use them when present.
     */
    auth?: 'public' | 'optional';
    /** RBAC: the caller must hold every listed permission. */
    permissions?: readonly Permission[];
    /** RBAC: the caller must hold at least one of these (e.g. enroll yourself, or enroll others). */
    anyPermission?: readonly Permission[];
  }
  interface FastifyRequest {
    principal: Principal | undefined;
  }
}

export interface AuthenticationOptions {
  tokens: AccessTokenService;
  apiKeys: ApiKeyService;
  permissions: PermissionResolver;
  revocation: SessionRevocation;
  quota: TenantQuota;
}

const BEARER = /^Bearer (\S+)$/;

async function resolvePrincipal(
  request: FastifyRequest,
  header: string,
  options: AuthenticationOptions,
): Promise<Principal> {
  const credential = BEARER.exec(header)?.[1];
  if (!credential) {
    throw new UnauthorizedError('Use "Authorization: Bearer <token>".', {
      code: 'INVALID_AUTHORIZATION_HEADER',
    });
  }

  // Partner systems: tenant-routable API keys.
  if (credential.startsWith('cbk_')) {
    const parsed = parseOpaqueToken(credential, 'cbk');
    if (!parsed)
      throw new UnauthorizedError('The API key is malformed.', { code: 'INVALID_API_KEY' });
    request.context.tenantId = parsed.tenantId;
    return options.apiKeys.authenticate(parsed);
  }

  // People: short-lived access tokens, checked against session revocation.
  const token = await options.tokens.verify(credential);
  // Bind the tenant first: the revocation fallback and permission lookup run under RLS.
  request.context.tenantId = token.tenantId;
  if (await options.revocation.isRevoked(token.sessionId)) {
    throw new UnauthorizedError('This session has ended. Sign in again.', {
      code: 'SESSION_REVOKED',
    });
  }
  return {
    kind: 'user',
    tenantId: token.tenantId,
    userId: token.userId,
    sessionId: token.sessionId,
    roles: token.roles,
    permissions: await options.permissions.forRoles(token.roles),
  };
}

const authenticationPluginImpl: FastifyPluginAsync<AuthenticationOptions> = async (
  app,
  options,
) => {
  app.decorateRequest('principal', undefined);

  // Document each route's requirement in OpenAPI, so the published contract and a test can both
  // see exactly which routes are open: [] = public, [{}, bearer] = optional, [bearer] = required.
  app.addHook('onRoute', (route) => {
    const mode = route.config?.auth;
    route.schema ??= {};
    Object.assign(route.schema, {
      security:
        mode === 'public'
          ? []
          : mode === 'optional'
            ? [{}, { bearerAuth: [] }]
            : [{ bearerAuth: [] }],
    });
  });

  app.addHook('onRequest', async (request) => {
    const { auth: mode, permissions = [], anyPermission = [] } = request.routeOptions.config;
    if (mode === 'public') return;

    const header = request.headers.authorization;
    if (!header) {
      // An `optional` route may run anonymously, unless it is permission-gated.
      if (mode === 'optional' && permissions.length === 0 && anyPermission.length === 0) return;
      throw new UnauthorizedError();
    }

    const principal = await resolvePrincipal(request, header, options);
    request.principal = principal;
    request.context.principal = principal;
    request.log = request.log.child(
      principal.kind === 'user'
        ? { tenantId: principal.tenantId, userId: principal.userId }
        : { tenantId: principal.tenantId, apiKeyId: principal.apiKeyId },
    );

    // Clients may state which school they mean; disagreeing with the credential is an error,
    // never a way to switch schools.
    const claimedTenant = request.headers['x-tenant-id'];
    if (claimedTenant !== undefined && claimedTenant !== principal.tenantId) {
      throw new ForbiddenError('The X-Tenant-Id header does not match your credentials.', {
        code: 'TENANT_MISMATCH',
      });
    }

    await options.quota.consume(principal.tenantId);
    // RBAC here, before the body is parsed and validated: a caller who may not use a route
    // learns nothing about its input schema and never makes the server parse its body.
    authorize(principal, permissions, anyPermission);
  });
};

/** RBAC: every permission in `required`, and at least one of `anyOf` when given. */
function authorize(
  principal: Principal,
  required: readonly Permission[],
  anyOf: readonly Permission[],
): void {
  const missing = required.filter((permission) => !principal.permissions.has(permission));
  if (missing.length > 0) {
    throw new ForbiddenError(`This action requires: ${missing.join(', ')}.`, {
      code: 'PERMISSION_DENIED',
    });
  }
  if (anyOf.length > 0 && !anyOf.some((permission) => principal.permissions.has(permission))) {
    throw new ForbiddenError(`This action requires one of: ${anyOf.join(', ')}.`, {
      code: 'PERMISSION_DENIED',
    });
  }
}

/** Applies to the scope it is registered in (the /api/v1 routes), not the whole app. */
export const authenticationPlugin = fp(authenticationPluginImpl, { name: 'authentication' });

/** For handlers that only make sense for a signed-in person (not an API key). */
export function requireUserPrincipal(request: FastifyRequest): UserPrincipal {
  const { principal } = request;
  if (!principal) throw new UnauthorizedError();
  if (principal.kind !== 'user') {
    throw new ForbiddenError('This action is only available to signed-in users.', {
      code: 'USER_REQUIRED',
    });
  }
  return principal;
}

export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw new UnauthorizedError();
  return request.principal;
}
