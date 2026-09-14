import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { AccessTokenService } from '../../auth/access-tokens.js';
import type { LoginThrottle } from '../../auth/login-throttle.js';
import { issueOpaqueToken, parseOpaqueToken } from '../../auth/opaque-tokens.js';
import type { PermissionResolver } from '../../auth/permission-resolver.js';
import type { Principal, UserPrincipal } from '../../auth/principal.js';
import type { SessionRevocation } from '../../auth/session-revocation.js';
import type { Permission } from '../../authz/permissions.js';
import { currentContext, runAsTenant } from '../../context/request-context.js';
import { requireTenantId } from '../../db/scope.js';
import type { TenantDb } from '../../db/tenant-db.js';
import type { TenantDirectory } from '../../db/tenant-directory.js';
import type { AuthMethod } from '../../generated/prisma/client.js';
import { ConflictError, TooManyRequestsError, UnauthorizedError } from '../../lib/errors.js';
import { hashPassword, needsRehash, verifyPassword } from '../../lib/password.js';
import type { AuditLogger } from '../audit/audit.service.js';

export interface AuthConfig {
  sessionTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
  user: { id: string; email: string; name: string };
  tenant: { id: string; slug: string; name: string };
  roles: string[];
  permissions: Permission[];
}

interface SessionUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
}

/**
 * A rotated refresh token presented again this soon is treated as a concurrent refresh from the
 * same client (two tabs), answered with 409 and no revocation. Later reuse means the token was
 * copied: the whole session is revoked.
 */
const REUSE_LEEWAY_MS = 10_000;

const invalidCredentials = () =>
  new UnauthorizedError('Invalid email or password.', { code: 'INVALID_CREDENTIALS' });
const invalidRefreshToken = () =>
  new UnauthorizedError('The refresh token is invalid or has expired. Sign in again.', {
    code: 'INVALID_REFRESH_TOKEN',
  });
const refreshInProgress = () =>
  new ConflictError('This refresh token was just used. Retry with the newest token.', {
    code: 'REFRESH_IN_PROGRESS',
  });

const earliest = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

export class AuthService {
  /** Unknown users are verified against this, so they cost as much time as a wrong password. */
  readonly #dummyHash: Promise<string>;

  constructor(
    private readonly deps: {
      db: TenantDb;
      directory: TenantDirectory;
      tokens: AccessTokenService;
      permissions: PermissionResolver;
      revocation: SessionRevocation;
      throttle: LoginThrottle;
      audit: AuditLogger;
      config: AuthConfig;
      logger: Logger;
    },
  ) {
    this.#dummyHash = hashPassword(randomBytes(24).toString('base64url'));
  }

  async login(input: {
    tenantSlug: string;
    email: string;
    password: string;
  }): Promise<IssuedSession> {
    const email = input.email.trim().toLowerCase();
    const tenant = await this.deps.directory.resolveBySlug(input.tenantSlug);
    if (tenant?.status !== 'active') {
      await verifyPassword(await this.#dummyHash, input.password);
      throw invalidCredentials();
    }

    return runAsTenant(tenant.id, async () => {
      const { db, throttle, audit } = this.deps;

      if (await throttle.isBlocked(tenant.id, email)) {
        await audit.record({
          action: 'auth.login.throttled',
          resourceType: 'user',
          actor: { type: 'user', id: null },
          metadata: { email },
        });
        throw new TooManyRequestsError('Too many failed sign-in attempts. Try again later.', {
          code: 'LOGIN_THROTTLED',
        });
      }

      const user = await db.client.user.findUnique({
        where: { tenantId_email: { tenantId: tenant.id, email } },
      });
      const passwordMatches = await verifyPassword(
        user?.passwordHash ?? (await this.#dummyHash),
        input.password,
      );

      if (!user || !passwordMatches || user.status !== 'active') {
        await throttle.recordFailure(tenant.id, email);
        if (user) {
          await db.client.user.update({
            where: { id: user.id },
            data: { failedLoginCount: { increment: 1 } },
          });
        }
        await audit.record({
          action: 'auth.login.failed',
          resourceType: 'user',
          resourceId: user?.id,
          actor: { type: 'user', id: user?.id ?? null },
          metadata: {
            email,
            reason: !user
              ? 'unknown_user'
              : !passwordMatches
                ? 'wrong_password'
                : `user_${user.status}`,
          },
        });
        throw invalidCredentials();
      }

      await throttle.reset(tenant.id, email);
      await db.client.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          failedLoginCount: 0,
          // Transparently upgrade hashes made with older argon2 parameters.
          ...(user.passwordHash && needsRehash(user.passwordHash)
            ? { passwordHash: await hashPassword(input.password) }
            : {}),
        },
      });
      const session = await this.startSession(user, 'password');
      await audit.record({
        action: 'auth.login.succeeded',
        resourceType: 'session',
        resourceId: session.sessionId,
        actor: { type: 'user', id: user.id },
        metadata: { method: 'password' },
      });
      return session;
    });
  }

  /** Opens a session for an already-authenticated user (password or SSO). Needs a tenant context. */
  async startSession(user: SessionUser, authMethod: AuthMethod): Promise<IssuedSession> {
    const tenantId = requireTenantId('Starting a session');
    const context = currentContext();
    const now = Date.now();
    const sessionExpiresAt = new Date(now + this.deps.config.sessionTtlSeconds * 1000);
    const refreshExpiresAt = earliest(
      new Date(now + this.deps.config.refreshTokenTtlSeconds * 1000),
      sessionExpiresAt,
    );
    const refresh = issueOpaqueToken('rt', tenantId);

    const session = await this.deps.db.transaction(async (tx) => {
      const created = await tx.session.create({
        data: {
          tenantId,
          userId: user.id,
          authMethod,
          ip: context?.ip ?? null,
          userAgent: context?.userAgent?.slice(0, 512) ?? null,
          expiresAt: sessionExpiresAt,
        },
      });
      await tx.refreshToken.create({
        data: {
          tenantId,
          sessionId: created.id,
          tokenHash: refresh.hash,
          expiresAt: refreshExpiresAt,
        },
      });
      return created;
    });

    return this.#issue(user, session.id, refresh.token, refreshExpiresAt);
  }

  /**
   * Rotates a refresh token: the presented token is claimed atomically and replaced. Presenting a
   * token that was already rotated (outside the concurrency leeway) revokes the whole session,
   * because only a stolen copy would still be in use.
   */
  async refresh(refreshToken: string): Promise<IssuedSession> {
    const parsed = parseOpaqueToken(refreshToken, 'rt');
    if (!parsed) throw invalidRefreshToken();

    return runAsTenant(parsed.tenantId, async () => {
      const { db, audit, config } = this.deps;
      const stored = await db.client.refreshToken.findUnique({
        where: { tenantId_tokenHash: { tenantId: parsed.tenantId, tokenHash: parsed.hash } },
        include: { session: { include: { user: true } } },
      });
      if (!stored) throw invalidRefreshToken();
      const { session } = stored;
      const now = new Date();

      if (stored.usedAt !== null || stored.revokedAt !== null) {
        const concurrentRefresh =
          stored.revokedAt === null &&
          session.revokedAt === null &&
          stored.usedAt !== null &&
          now.getTime() - stored.usedAt.getTime() < REUSE_LEEWAY_MS;
        if (concurrentRefresh) throw refreshInProgress();

        await this.revokeSessions([session.id], 'refresh_token_reuse');
        await audit.record({
          action: 'auth.refresh_token.reuse_detected',
          resourceType: 'session',
          resourceId: session.id,
          actor: { type: 'user', id: session.userId },
          metadata: { refreshTokenId: stored.id },
        });
        this.deps.logger.warn(
          { sessionId: session.id },
          'refresh token reuse detected; session revoked',
        );
        throw invalidRefreshToken();
      }

      if (
        stored.expiresAt <= now ||
        session.revokedAt !== null ||
        session.expiresAt <= now ||
        session.user.status !== 'active'
      ) {
        throw invalidRefreshToken();
      }

      const next = issueOpaqueToken('rt', parsed.tenantId);
      const nextExpiresAt = earliest(
        new Date(now.getTime() + config.refreshTokenTtlSeconds * 1000),
        session.expiresAt,
      );
      await db.transaction(async (tx) => {
        // Conditional claim: of two concurrent refreshes, exactly one updates the row.
        const claimed = await tx.refreshToken.updateMany({
          where: { id: stored.id, usedAt: null, revokedAt: null },
          data: { usedAt: now },
        });
        if (claimed.count !== 1) throw refreshInProgress();
        const created = await tx.refreshToken.create({
          data: {
            tenantId: parsed.tenantId,
            sessionId: session.id,
            tokenHash: next.hash,
            expiresAt: nextExpiresAt,
          },
        });
        await tx.refreshToken.update({
          where: { id: stored.id },
          data: { replacedById: created.id },
        });
        await tx.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
      });

      return this.#issue(session.user, session.id, next.token, nextExpiresAt);
    });
  }

  /** Revokes sessions and their refresh tokens; access tokens stop working immediately. */
  async revokeSessions(sessionIds: readonly string[], reason: string): Promise<void> {
    if (sessionIds.length === 0) return;
    const now = new Date();
    await this.deps.db.transaction(async (tx) => {
      await tx.session.updateMany({
        where: { id: { in: [...sessionIds] }, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      });
      await tx.refreshToken.updateMany({
        where: { sessionId: { in: [...sessionIds] }, revokedAt: null },
        data: { revokedAt: now },
      });
    });
    await this.deps.revocation.markRevoked(sessionIds);
  }

  async logout(principal: UserPrincipal): Promise<void> {
    await this.revokeSessions([principal.sessionId], 'logout');
    await this.deps.audit.record({
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: principal.sessionId,
    });
  }

  /** Logout when the access token has already expired: identify the session by its refresh token. */
  async logoutWithRefreshToken(refreshToken: string): Promise<void> {
    const parsed = parseOpaqueToken(refreshToken, 'rt');
    if (!parsed) return;
    await runAsTenant(parsed.tenantId, async () => {
      const stored = await this.deps.db.client.refreshToken.findUnique({
        where: { tenantId_tokenHash: { tenantId: parsed.tenantId, tokenHash: parsed.hash } },
        select: { sessionId: true, session: { select: { userId: true } } },
      });
      if (!stored) return;
      await this.revokeSessions([stored.sessionId], 'logout');
      await this.deps.audit.record({
        action: 'auth.logout',
        resourceType: 'session',
        resourceId: stored.sessionId,
        actor: { type: 'user', id: stored.session.userId },
      });
    });
  }

  async logoutAll(principal: UserPrincipal): Promise<number> {
    const sessions = await this.deps.db.client.session.findMany({
      where: { userId: principal.userId, revokedAt: null },
      select: { id: true },
    });
    const ids = sessions.map((session) => session.id);
    await this.revokeSessions(ids, 'logout_all');
    await this.deps.audit.record({
      action: 'auth.logout_all',
      resourceType: 'user',
      resourceId: principal.userId,
      metadata: { sessionsRevoked: ids.length },
    });
    return ids.length;
  }

  /** The current principal, for GET /auth/me. */
  async describe(principal: Principal) {
    const { db } = this.deps;
    const tenant = await db.client.tenant.findUniqueOrThrow({
      where: { id: principal.tenantId },
      select: { id: true, slug: true, name: true, settings: true },
    });
    const settings = tenant.settings as { branding?: Record<string, unknown> } | null;
    const tenantView = {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      branding: settings?.branding ?? {},
    };
    const permissions = [...principal.permissions].sort();

    if (principal.kind === 'user') {
      const user = await db.client.user.findUniqueOrThrow({
        where: { id: principal.userId },
        select: { id: true, email: true, name: true },
      });
      return {
        kind: 'user' as const,
        user,
        tenant: tenantView,
        roles: [...principal.roles],
        permissions,
      };
    }
    const apiKey = await db.client.apiKey.findUniqueOrThrow({
      where: { id: principal.apiKeyId },
      select: { id: true, name: true },
    });
    return { kind: 'api_key' as const, apiKey, tenant: tenantView, roles: [], permissions };
  }

  async #issue(
    user: SessionUser,
    sessionId: string,
    refreshToken: string,
    refreshTokenExpiresAt: Date,
  ): Promise<IssuedSession> {
    const { roles, permissions } = await this.deps.permissions.forUser(user.id);
    const tenant = await this.deps.db.client.tenant.findUniqueOrThrow({
      where: { id: user.tenantId },
      select: { id: true, slug: true, name: true },
    });
    const access = await this.deps.tokens.sign({
      userId: user.id,
      tenantId: user.tenantId,
      sessionId,
      roles,
    });
    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken,
      refreshTokenExpiresAt,
      sessionId,
      user: { id: user.id, email: user.email, name: user.name },
      tenant,
      roles,
      permissions: [...permissions].sort(),
    };
  }
}
