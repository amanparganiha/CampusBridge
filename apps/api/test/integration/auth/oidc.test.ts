import { OAuth2Server } from 'oauth2-mock-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { integrationSecretsContext } from '../../../src/modules/auth/oidc/oidc.config.js';
import type { ProvisionedTenant } from '../../../src/modules/tenants/provisioning.js';
import { startTestApp, TEST_ADMIN_URL, type SessionBody, type TestApp } from '../helpers/app.js';
import {
  connectTestDatabases,
  createTestTenant,
  createTestUser,
  type TestDatabases,
} from '../helpers/database.js';

/**
 * The full authorization-code flow against a real (mock) OpenID provider: discovery, PKCE,
 * state, nonce, signed ID tokens. The "browser" is simulated by following redirects by hand.
 */
describe('single sign-on (OIDC)', () => {
  let idp: OAuth2Server;
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: ProvisionedTenant;
  /** Claims the identity provider asserts in the next ID token. */
  let identity: Record<string, unknown>;

  const http = () => request(testApp.app.server);

  async function configureSso(tenant: ProvisionedTenant, overrides: Record<string, unknown> = {}) {
    const tenantId = tenant.tenant.id;
    const data = {
      status: 'connected' as const,
      config: {
        issuer: idp.issuer.url!,
        clientId: 'campusbridge',
        allowedEmailDomains: ['sso.test'],
        jitProvisioning: true,
        defaultRoleKey: 'student',
        ...overrides,
      },
      credentialsEnc: testApp.container.encryptor.encryptJson(
        { clientSecret: 'mock-client-secret' },
        integrationSecretsContext(tenantId, 'oidc'),
      ),
    };
    await dbs.owner.integration.upsert({
      where: { tenantId_provider: { tenantId, provider: 'oidc' } },
      create: { tenantId, provider: 'oidc', ...data },
      update: data,
    });
  }

  /** Starts SSO, lets the IdP redirect back, and returns the query our callback receives. */
  async function ssoRoundTrip(tenantSlug: string, returnTo?: string): Promise<string> {
    const start = await http()
      .get(`/api/v1/auth/oidc/${tenantSlug}/authorize`)
      .query(returnTo ? { returnTo } : {})
      .expect(302);
    const authorizeUrl = new URL(start.headers.location!);
    expect(authorizeUrl.origin).toBe(new URL(idp.issuer.url!).origin);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');

    // The browser visits the IdP, which (auto-approving) redirects back with a code.
    const idpResponse = await fetch(authorizeUrl, { redirect: 'manual' });
    return new URL(idpResponse.headers.get('location')!).search;
  }

  const callback = (query: string) => http().get(`/api/v1/auth/oidc/callback${query}`);

  async function signIn(tenant: ProvisionedTenant, returnTo?: string) {
    return callback(await ssoRoundTrip(tenant.tenant.slug, returnTo));
  }

  /** Exchanges the refresh cookie from the callback for a session, as the admin app would. */
  async function sessionFrom(
    callbackResponse: request.Response,
    tenant: ProvisionedTenant,
  ): Promise<SessionBody> {
    const cookie = [callbackResponse.headers['set-cookie']]
      .flat()
      .find((value) => value?.startsWith(`cb_rt_${tenant.tenant.id}=`));
    expect(cookie).toBeDefined();
    const response = await http()
      .post('/api/v1/auth/refresh')
      .set('cookie', cookie!.split(';')[0]!)
      .set('x-csrf-protection', '1')
      .send({ tenantId: tenant.tenant.id })
      .expect(200);
    return response.body as SessionBody;
  }

  const errorOf = (response: request.Response) =>
    new URL(response.headers.location!).searchParams.get('error');

  beforeAll(async () => {
    idp = new OAuth2Server();
    await idp.issuer.keys.generate('RS256');
    await idp.start(0, 'localhost');
    idp.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }) => {
      Object.assign(token.payload, identity);
    });

    dbs = connectTestDatabases();
    testApp = await startTestApp();
    school = await createTestTenant(dbs.owner, 'sso');
    await configureSso(school);
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
    await idp.stop();
  });

  beforeEach(() => {
    identity = {
      sub: `idp-${crypto.randomUUID()}`,
      email: `person-${crypto.randomUUID().slice(0, 8)}@sso.test`,
      email_verified: true,
      name: 'Ada Lovelace',
    };
  });

  it('provisions a new user just in time and signs them in', async () => {
    const response = await signIn(school);

    expect(response.status).toBe(302);
    const landing = new URL(response.headers.location!);
    expect(`${landing.origin}${landing.pathname}`).toBe(`${TEST_ADMIN_URL}/auth/callback`);
    expect(landing.searchParams.get('tenant')).toBe(school.tenant.slug);

    const session = await sessionFrom(response, school);
    expect(session.user).toMatchObject({ email: identity.email, name: 'Ada Lovelace' });
    expect(session.roles).toEqual(['student']);

    const linked = await dbs.owner.userIdentity.findFirstOrThrow({
      where: { subject: identity.sub as string },
    });
    expect(linked).toMatchObject({
      tenantId: school.tenant.id,
      userId: session.user.id,
      issuer: idp.issuer.url,
    });
    const actions = await dbs.owner.auditLog.findMany({
      where: { tenantId: school.tenant.id, actorId: session.user.id },
      select: { action: true },
    });
    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['auth.sso.user_provisioned', 'auth.sso.login.succeeded']),
    );
  });

  it('recognises a returning identity instead of creating a second account', async () => {
    const first = await sessionFrom(await signIn(school), school);
    const second = await sessionFrom(await signIn(school), school);

    expect(second.user.id).toBe(first.user.id);
    expect(
      await dbs.owner.user.count({
        where: { tenantId: school.tenant.id, email: identity.email as string },
      }),
    ).toBe(1);
  });

  it('links an existing account by verified email and completes a pending invitation', async () => {
    const invited = await createTestUser(dbs.owner, school, {
      role: 'instructor',
      email: identity.email as string,
      status: 'invited',
      passwordHash: null,
    });

    const session = await sessionFrom(await signIn(school), school);

    expect(session.user.id).toBe(invited.id);
    expect(session.roles).toEqual(['instructor']);
    expect((await dbs.owner.user.findUniqueOrThrow({ where: { id: invited.id } })).status).toBe(
      'active',
    );
  });

  it.each([
    [
      'an email domain the school does not allow',
      { email: 'intruder@evil.test' },
      'domain_not_allowed',
    ],
    ['an unverified email', { email_verified: false }, 'email_unverified'],
    ['no email at all', { email: undefined }, 'email_missing'],
  ])('refuses %s', async (_label, claims, code) => {
    identity = { ...identity, ...claims };

    const response = await signIn(school);

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe(code);
    expect(
      [response.headers['set-cookie']].flat().some((value) => value?.startsWith('cb_rt_')),
    ).toBe(false);
  });

  it('refuses unknown people when just-in-time provisioning is off', async () => {
    const closed = await createTestTenant(dbs.owner, 'sso-closed');
    await configureSso(closed, { jitProvisioning: false });

    expect(errorOf(await signIn(closed))).toBe('not_provisioned');
  });

  it('refuses suspended accounts', async () => {
    await createTestUser(dbs.owner, school, {
      role: 'student',
      email: identity.email as string,
      status: 'suspended',
    });

    expect(errorOf(await signIn(school))).toBe('account_disabled');
  });

  it('accepts each callback only once (no replay)', async () => {
    const query = await ssoRoundTrip(school.tenant.slug);

    expect((await callback(query)).headers.location).toContain('/auth/callback');
    expect(errorOf(await callback(query))).toBe('login_expired');
  });

  it('fails the code exchange if the PKCE verifier does not match', async () => {
    const query = await ssoRoundTrip(school.tenant.slug);
    const state = new URLSearchParams(query).get('state')!;
    const redis = testApp.container.redis!;
    const pending = JSON.parse((await redis.get(`cb:oidc:state:${state}`))!) as Record<
      string,
      string
    >;
    await redis.set(
      `cb:oidc:state:${state}`,
      JSON.stringify({ ...pending, codeVerifier: 'x'.repeat(64) }),
    );

    expect(errorOf(await callback(query))).toBe('idp_error');
  });

  it('only ever redirects back to a relative path (no open redirect)', async () => {
    const hostile = new URL((await signIn(school, '//evil.test/steal')).headers.location!);
    expect(hostile.searchParams.get('returnTo')).toBe('/');

    const friendly = new URL((await signIn(school, '/courses/42')).headers.location!);
    expect(friendly.searchParams.get('returnTo')).toBe('/courses/42');
  });

  it('sends the user back when SSO is not configured or the IdP refuses', async () => {
    const noSso = await createTestTenant(dbs.owner, 'no-sso');
    const start = await http().get(`/api/v1/auth/oidc/${noSso.tenant.slug}/authorize`).expect(302);
    expect(errorOf(start)).toBe('sso_not_configured');

    const query = await ssoRoundTrip(school.tenant.slug);
    const state = new URLSearchParams(query).get('state')!;
    const denied = await callback(`?error=access_denied&state=${state}`);
    expect(errorOf(denied)).toBe('idp_denied');
    // The pending login is discarded, so the real code cannot be used afterwards either.
    expect(errorOf(await callback(query))).toBe('login_expired');
  });
});
