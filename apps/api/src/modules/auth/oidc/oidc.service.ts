import type { Redis } from 'ioredis';
import * as client from 'openid-client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { runAsTenant } from '../../../context/request-context.js';
import { requireTenantId } from '../../../db/scope.js';
import type { TenantDb } from '../../../db/tenant-db.js';
import type { TenantDirectory } from '../../../db/tenant-directory.js';
import type { User } from '../../../generated/prisma/client.js';
import type { Encryptor } from '../../../lib/crypto/encryption.js';
import type { AuditLogger } from '../../audit/audit.service.js';
import type { AuthService, IssuedSession } from '../auth.service.js';
import {
  integrationSecretsContext,
  oidcConfigSchema,
  oidcCredentialsSchema,
  type OidcConfig,
} from './oidc.config.js';

/** A sign-in that ends back on the admin login page with a machine-readable reason. */
export class OidcLoginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OidcLoginError';
  }
}

const pendingLoginSchema = z.object({
  tenantId: z.uuid(),
  tenantSlug: z.string(),
  codeVerifier: z.string(),
  nonce: z.string(),
  returnTo: z.string(),
});
type PendingLogin = z.infer<typeof pendingLoginSchema>;

const PENDING_LOGIN_TTL_SECONDS = 600;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const pendingKey = (state: string) => `cb:oidc:state:${state}`;

interface LoadedProvider {
  config: OidcConfig;
  configuration: client.Configuration;
}

/**
 * Institutional single sign-on: OpenID Connect authorization code flow with PKCE, state and
 * nonce, against the identity provider each school configures for itself.
 *
 * Trust boundary: a school's IdP can only vouch for accounts *at that school*. Users are
 * per-school records, so a hostile IdP at one school can never reach another school's data.
 */
export class OidcService {
  readonly #discovery = new Map<
    string,
    { configuration: client.Configuration; expiresAt: number }
  >();

  constructor(
    private readonly deps: {
      db: TenantDb;
      directory: TenantDirectory;
      redis: Redis;
      encryptor: Encryptor;
      auth: AuthService;
      audit: AuditLogger;
      logger: Logger;
      /** The single callback URL registered with every IdP. */
      redirectUri: string;
      /** Development only: permit http:// issuers such as local Keycloak. */
      allowInsecureRequests: boolean;
    },
  ) {}

  /** Starts a sign-in: returns the IdP URL to redirect the browser to. */
  async beginLogin(tenantSlug: string, returnTo: string): Promise<URL> {
    const tenant = await this.deps.directory.resolveBySlug(tenantSlug);
    if (tenant?.status !== 'active') {
      throw new OidcLoginError('unknown_school', 'This school does not exist or is not active.');
    }

    return runAsTenant(tenant.id, async () => {
      const { configuration } = await this.#loadProvider();
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const pending: PendingLogin = {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        codeVerifier,
        nonce,
        returnTo,
      };
      await this.deps.redis.set(
        pendingKey(state),
        JSON.stringify(pending),
        'EX',
        PENDING_LOGIN_TTL_SECONDS,
      );

      return client.buildAuthorizationUrl(configuration, {
        redirect_uri: this.deps.redirectUri,
        scope: 'openid email profile',
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
    });
  }

  /** Drops a pending login without completing it (e.g. the user cancelled at the IdP). */
  async discardLogin(state: string | undefined): Promise<string | undefined> {
    if (!state) return undefined;
    const raw = await this.deps.redis.getdel(pendingKey(state));
    return raw ? pendingLoginSchema.safeParse(JSON.parse(raw)).data?.tenantSlug : undefined;
  }

  /** Completes a sign-in from the IdP's redirect back to us. */
  async completeLogin(
    callbackUrl: URL,
  ): Promise<{ session: IssuedSession; tenantSlug: string; returnTo: string }> {
    const state = callbackUrl.searchParams.get('state');
    // Single use: GETDEL means a replayed callback finds nothing.
    const raw = state ? await this.deps.redis.getdel(pendingKey(state)) : null;
    const pending = raw ? pendingLoginSchema.safeParse(JSON.parse(raw)).data : undefined;
    if (!state || !pending) {
      throw new OidcLoginError(
        'login_expired',
        'This sign-in expired or was already used. Please start again.',
      );
    }

    return runAsTenant(pending.tenantId, async () => {
      const { config, configuration } = await this.#loadProvider();

      let claims: client.IDToken | undefined;
      try {
        const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
          pkceCodeVerifier: pending.codeVerifier,
          expectedState: state,
          expectedNonce: pending.nonce,
          idTokenExpected: true,
        });
        claims = tokens.claims();
      } catch (err) {
        this.deps.logger.warn({ err }, 'OIDC code exchange or ID token validation failed');
        throw new OidcLoginError('idp_error', 'The identity provider did not confirm the sign-in.');
      }
      if (!claims)
        throw new OidcLoginError('idp_error', 'The identity provider returned no identity.');

      const session = await this.#signIn(config, configuration.serverMetadata().issuer, claims);
      return { session, tenantSlug: pending.tenantSlug, returnTo: pending.returnTo };
    });
  }

  async #signIn(
    config: OidcConfig,
    issuer: string,
    claims: client.IDToken,
  ): Promise<IssuedSession> {
    const { db, audit, auth } = this.deps;
    const tenantId = requireTenantId('SSO sign-in');
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : undefined;

    const reject = async (code: string, message: string): Promise<never> => {
      await audit.record({
        action: 'auth.sso.login.rejected',
        resourceType: 'user',
        actor: { type: 'user', id: null },
        metadata: { reason: code, email: email ?? null, issuer, subject: claims.sub },
      });
      throw new OidcLoginError(code, message);
    };

    if (!email)
      return reject('email_missing', 'Your identity provider did not share an email address.');
    // Only a verified email proves the person controls the address we match accounts on.
    if (claims.email_verified !== true) {
      return reject(
        'email_unverified',
        'Your identity provider has not verified your email address.',
      );
    }
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!config.allowedEmailDomains.includes(domain)) {
      return reject(
        'domain_not_allowed',
        'Accounts from this email domain cannot sign in to this school.',
      );
    }

    const identity = await db.client.userIdentity.findUnique({
      where: { tenantId_issuer_subject: { tenantId, issuer, subject: claims.sub } },
      include: { user: true },
    });

    let user: User;
    let provisioned = false;
    if (identity) {
      user = identity.user;
      if (user.status === 'suspended')
        return reject('account_disabled', 'Your account is disabled.');
      await db.client.userIdentity.update({
        where: { id: identity.id },
        data: { lastLoginAt: new Date() },
      });
    } else {
      const existing = await db.client.user.findUnique({
        where: { tenantId_email: { tenantId, email } },
      });
      if (existing?.status === 'suspended')
        return reject('account_disabled', 'Your account is disabled.');
      if (!existing && !config.jitProvisioning) {
        return reject('not_provisioned', 'You do not have an account at this school yet.');
      }

      const linked = await db.transaction(async (tx) => {
        let account: User;
        if (existing) {
          // A verified email from the school's own IdP proves ownership: link it, and complete
          // a pending invitation if there was one.
          account =
            existing.status === 'invited'
              ? await tx.user.update({ where: { id: existing.id }, data: { status: 'active' } })
              : existing;
        } else {
          const role = await tx.role.findUnique({
            where: { tenantId_key: { tenantId, key: config.defaultRoleKey } },
          });
          if (!role) throw new Error(`SSO default role "${config.defaultRoleKey}" does not exist`);
          account = await tx.user.create({
            data: { tenantId, email, name: displayNameOf(claims, email), status: 'active' },
          });
          await tx.userRole.create({ data: { tenantId, userId: account.id, roleId: role.id } });
        }
        await tx.userIdentity.create({
          data: {
            tenantId,
            userId: account.id,
            issuer,
            subject: claims.sub,
            email,
            lastLoginAt: new Date(),
          },
        });
        return { account, provisioned: !existing };
      });
      user = linked.account;
      provisioned = linked.provisioned;
    }

    if (provisioned) {
      await audit.record({
        action: 'auth.sso.user_provisioned',
        resourceType: 'user',
        resourceId: user.id,
        actor: { type: 'user', id: user.id },
        metadata: { issuer, role: config.defaultRoleKey },
      });
    }
    await db.client.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const session = await auth.startSession(user, 'oidc');
    await audit.record({
      action: 'auth.sso.login.succeeded',
      resourceType: 'session',
      resourceId: session.sessionId,
      actor: { type: 'user', id: user.id },
      metadata: { method: 'oidc', issuer },
    });
    return session;
  }

  async #loadProvider(): Promise<LoadedProvider> {
    const tenantId = requireTenantId('Loading SSO settings');
    const integration = await this.deps.db.client.integration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'oidc' } },
    });
    if (integration?.status !== 'connected' || !integration.credentialsEnc) {
      throw new OidcLoginError(
        'sso_not_configured',
        'Single sign-on is not set up for this school.',
      );
    }
    const config = oidcConfigSchema.parse(integration.config);

    // Keyed by row version, so editing the settings takes effect immediately.
    const cacheKey = `${integration.id}:${String(integration.updatedAt.getTime())}`;
    const cached = this.#discovery.get(cacheKey);
    if (cached && cached.expiresAt > Date.now())
      return { config, configuration: cached.configuration };

    const { clientSecret } = this.deps.encryptor.decryptJson(
      integration.credentialsEnc,
      integrationSecretsContext(tenantId, 'oidc'),
      oidcCredentialsSchema,
    );
    let configuration: client.Configuration;
    try {
      configuration = await client.discovery(
        new URL(config.issuer),
        config.clientId,
        undefined,
        client.ClientSecretPost(clientSecret),
        this.deps.allowInsecureRequests
          ? // Local Keycloak speaks plain http. The container passes false in production.
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            { execute: [client.allowInsecureRequests] }
          : undefined,
      );
    } catch (err) {
      this.deps.logger.error({ err, issuer: config.issuer }, 'OIDC discovery failed');
      throw new OidcLoginError('idp_unavailable', 'The school’s identity provider is unreachable.');
    }
    this.#discovery.set(cacheKey, { configuration, expiresAt: Date.now() + DISCOVERY_TTL_MS });
    return { config, configuration };
  }
}

function displayNameOf(claims: client.IDToken, email: string): string {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const full = text(claims.name);
  if (full) return full;
  const parts = [text(claims.given_name), text(claims.family_name)].filter(Boolean);
  return parts.length ? parts.join(' ') : email.slice(0, email.indexOf('@'));
}
