import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, importJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningJwk } from '../../../src/config/secrets.js';
import type { ProblemDetails } from '../../../src/lib/errors.js';
import type { ProvisionedTenant } from '../../../src/modules/tenants/provisioning.js';
import {
  bearer,
  login,
  startTestApp,
  TEST_PUBLIC_API_URL,
  testSecrets,
  type SessionBody,
  type TestApp,
} from '../helpers/app.js';
import {
  connectTestDatabases,
  createTestTenant,
  createTestUser,
  TEST_PASSWORD,
  type TestDatabases,
} from '../helpers/database.js';

const problem = (response: request.Response) => response.body as ProblemDetails;

describe('password sign-in and sessions', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: ProvisionedTenant;
  let otherSchool: ProvisionedTenant;
  let student: { id: string; email: string };

  const credentials = () => ({
    tenant: school.tenant.slug,
    email: student.email,
    password: TEST_PASSWORD,
  });
  const http = () => request(testApp.app.server);

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    school = await createTestTenant(dbs.owner, 'sessions');
    otherSchool = await createTestTenant(dbs.owner, 'sessions-other');
    student = await createTestUser(dbs.owner, school, { role: 'student' });
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  describe('login', () => {
    it('issues an access token, a rotating refresh token and the caller’s permissions', async () => {
      const session = await login(testApp.app, credentials());

      expect(session).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 900,
        user: { id: student.id, email: student.email },
        tenant: { id: school.tenant.id, slug: school.tenant.slug },
        roles: ['student'],
      });
      expect(session.refreshToken).toMatch(new RegExp(`^rt_${school.tenant.id}_`));
      expect(session.permissions).toContain('enrollment:self');
      expect(session.permissions).not.toContain('course:create');
    });

    it('sets the refresh token as an HttpOnly, SameSite=Strict cookie scoped to auth routes by default', async () => {
      const response = await http().post('/api/v1/auth/login').send(credentials()).expect(200);
      const cookie = [response.headers['set-cookie']]
        .flat()
        .find((value) => value?.startsWith(`cb_rt_${school.tenant.id}=`));

      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      expect((response.body as SessionBody).refreshToken).toBeUndefined();
    });

    it('gives the same answer for a wrong password, an unknown email and an unknown school', async () => {
      const attempts = await Promise.all([
        http()
          .post('/api/v1/auth/login')
          .send({ ...credentials(), password: 'wrong-password-99' }),
        http()
          .post('/api/v1/auth/login')
          .send({ ...credentials(), email: 'nobody@nowhere.test' }),
        http()
          .post('/api/v1/auth/login')
          .send({ ...credentials(), tenant: 'no-such-school' }),
      ]);

      for (const response of attempts) {
        expect(response.status).toBe(401);
        expect(problem(response)).toMatchObject({
          code: 'INVALID_CREDENTIALS',
          detail: 'Invalid email or password.',
        });
      }
    });

    it('refuses suspended accounts even with the right password', async () => {
      const suspended = await createTestUser(dbs.owner, school, {
        role: 'student',
        status: 'suspended',
      });

      const response = await http()
        .post('/api/v1/auth/login')
        .send({ tenant: school.tenant.slug, email: suspended.email, password: TEST_PASSWORD })
        .expect(401);

      expect(problem(response).code).toBe('INVALID_CREDENTIALS');
    });

    it('throttles repeated failures per email, whether or not the account exists', async () => {
      const throttled = await startTestApp({ LOGIN_MAX_FAILURES: '3' });
      const target = await createTestUser(dbs.owner, school, { role: 'student' });
      try {
        for (const email of [`ghost-${randomUUID()}@nowhere.test`, target.email]) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await request(throttled.app.server)
              .post('/api/v1/auth/login')
              .send({ tenant: school.tenant.slug, email, password: 'wrong-password-99' })
              .expect(401);
          }
          // Now blocked even with the right password, and identically for real and fake emails.
          const blocked = await request(throttled.app.server)
            .post('/api/v1/auth/login')
            .send({ tenant: school.tenant.slug, email, password: TEST_PASSWORD })
            .expect(429);
          expect(problem(blocked).code).toBe('LOGIN_THROTTLED');
        }
      } finally {
        await throttled.close();
      }
    });

    it('audits successes and failures with the reason', async () => {
      const auditUser = await createTestUser(dbs.owner, school, { role: 'student' });
      await http()
        .post('/api/v1/auth/login')
        .send({ tenant: school.tenant.slug, email: auditUser.email, password: 'wrong-password-99' })
        .expect(401);
      await login(testApp.app, {
        tenant: school.tenant.slug,
        email: auditUser.email,
        password: TEST_PASSWORD,
      });

      const entries = await dbs.owner.auditLog.findMany({
        where: { tenantId: school.tenant.id, resourceId: { not: null }, actorId: auditUser.id },
        orderBy: { id: 'asc' },
      });
      expect(entries.map((entry) => entry.action)).toEqual([
        'auth.login.failed',
        'auth.login.succeeded',
      ]);
      expect(entries[0]!.metadata).toMatchObject({ reason: 'wrong_password' });
      expect(entries[1]!.requestId).toBeTruthy();

      const after = await dbs.owner.user.findUniqueOrThrow({ where: { id: auditUser.id } });
      expect(after.failedLoginCount).toBe(0);
      expect(after.lastLoginAt).not.toBeNull();
    });
  });

  describe('access tokens', () => {
    it('is secure by default: API routes reject anonymous requests', async () => {
      const response = await http().get('/api/v1/auth/me').expect(401);

      expect(response.headers['www-authenticate']).toBe('Bearer');
    });

    it('identifies the caller on /auth/me', async () => {
      const session = await login(testApp.app, credentials());

      const response = await http()
        .get('/api/v1/auth/me')
        .set(bearer(session.accessToken))
        .expect(200);

      expect(response.body).toMatchObject({
        kind: 'user',
        user: { id: student.id },
        tenant: { id: school.tenant.id },
        roles: ['student'],
      });
    });

    it('rejects expired, forged and malformed tokens', async () => {
      const now = Math.floor(Date.now() / 1000);
      const mint = async (key: JWK, expiresAt: number) =>
        new SignJWT({ tid: school.tenant.id, sid: randomUUID(), roles: ['admin'] })
          .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: key.kid! })
          .setSubject(student.id)
          .setIssuer(TEST_PUBLIC_API_URL)
          .setAudience('campusbridge-api')
          .setJti(randomUUID())
          .setIssuedAt(now - 3600)
          .setExpirationTime(expiresAt)
          .sign(await importJWK(key, 'ES256'));

      // Signed with the real key, but past its expiry.
      const realKey = (await testSecrets()).jwtPrivateJwks.keys[0]!;
      const expired = problemOf(
        await http()
          .get('/api/v1/auth/me')
          .set(bearer(await mint(realKey, now - 1800))),
      );
      expect(expired).toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });

      // Claims "admin", but signed by a key the API does not trust.
      const forged = await mint(await generateSigningJwk(), now + 600);
      for (const token of [forged, 'not.a.jwt', 'eyJhbGciOiJub25lIn0.e30.']) {
        const response = await http().get('/api/v1/auth/me').set(bearer(token)).expect(401);
        expect(problem(response).code).toBe('TOKEN_INVALID');
      }
      await http().get('/api/v1/auth/me').set('authorization', 'Basic dXNlcjpwYXNz').expect(401);
    });

    it('refuses a token presented with another school in X-Tenant-Id', async () => {
      const session = await login(testApp.app, credentials());

      const response = await http()
        .get('/api/v1/auth/me')
        .set(bearer(session.accessToken))
        .set('x-tenant-id', otherSchool.tenant.id)
        .expect(403);

      expect(problem(response).code).toBe('TENANT_MISMATCH');
    });

    it('publishes verification keys that validate issued tokens (JWKS)', async () => {
      const session = await login(testApp.app, credentials());
      const jwks = await http().get('/.well-known/jwks.json').expect(200);
      const keySet = jwks.body as { keys: Record<string, unknown>[] };

      expect(keySet.keys.every((key) => !('d' in key))).toBe(true);
      // What another service would do: verify offline with nothing but the published keys.
      const { payload } = await jwtVerify(session.accessToken, createLocalJWKSet(keySet), {
        issuer: TEST_PUBLIC_API_URL,
        audience: 'campusbridge-api',
      });
      expect(payload).toMatchObject({ sub: student.id, tid: school.tenant.id });
    });
  });

  describe('refresh token rotation', () => {
    const refresh = (refreshToken: string) =>
      http().post('/api/v1/auth/refresh').send({ refreshToken });

    it('rotates: each refresh returns a new refresh token and a working access token', async () => {
      const first = await login(testApp.app, credentials());
      const rotated = (await refresh(first.refreshToken!).expect(200)).body as SessionBody;

      expect(rotated.refreshToken).not.toBe(first.refreshToken);
      await http().get('/api/v1/auth/me').set(bearer(rotated.accessToken)).expect(200);
    });

    it('answers a near-simultaneous second use with 409, without ending the session', async () => {
      const session = await login(testApp.app, credentials());

      const [a, b] = await Promise.all([
        refresh(session.refreshToken!),
        refresh(session.refreshToken!),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const winner = (a.status === 200 ? a : b).body as SessionBody;
      await http().get('/api/v1/auth/me').set(bearer(winner.accessToken)).expect(200);
      await refresh(winner.refreshToken!).expect(200);
    });

    it('treats later reuse of a rotated token as theft: the whole session is revoked', async () => {
      const session = await login(testApp.app, credentials());
      const rotated = (await refresh(session.refreshToken!).expect(200)).body as SessionBody;
      // Pretend the rotation happened a minute ago (beyond the concurrency leeway).
      await dbs.owner.refreshToken.updateMany({
        where: { replacedById: { not: null }, session: { id: sessionIdOf(rotated) } },
        data: { usedAt: new Date(Date.now() - 60_000) },
      });

      const replay = await refresh(session.refreshToken!).expect(401);
      expect(problem(replay).code).toBe('INVALID_REFRESH_TOKEN');

      // Every credential of that session is now dead, including the legitimate newest ones.
      await refresh(rotated.refreshToken!).expect(401);
      const me = await http().get('/api/v1/auth/me').set(bearer(rotated.accessToken)).expect(401);
      expect(problem(me).code).toBe('SESSION_REVOKED');

      const audit = await dbs.owner.auditLog.findFirst({
        where: {
          tenantId: school.tenant.id,
          action: 'auth.refresh_token.reuse_detected',
          resourceId: sessionIdOf(rotated),
        },
      });
      expect(audit).not.toBeNull();
    });

    it('does not accept a refresh token rewritten to name another school', async () => {
      const session = await login(testApp.app, credentials());
      const forged = session.refreshToken!.replace(school.tenant.id, otherSchool.tenant.id);

      await refresh(forged).expect(401);
      await refresh('rt_not-even-close').expect(401);
    });

    it('uses the per-school cookie only with the CSRF header', async () => {
      const response = await http().post('/api/v1/auth/login').send(credentials()).expect(200);
      const cookie = [response.headers['set-cookie']]
        .flat()
        .find((value) => value?.startsWith('cb_rt_'))!
        .split(';')[0]!;

      const withoutHeader = await http()
        .post('/api/v1/auth/refresh')
        .set('cookie', cookie)
        .send({ tenantId: school.tenant.id })
        .expect(403);
      expect(problem(withoutHeader).code).toBe('CSRF_HEADER_REQUIRED');

      const withHeader = await http()
        .post('/api/v1/auth/refresh')
        .set('cookie', cookie)
        .set('x-csrf-protection', '1')
        .send({ tenantId: school.tenant.id })
        .expect(200);
      expect(
        [withHeader.headers['set-cookie']]
          .flat()
          .some((value) => value?.startsWith(`cb_rt_${school.tenant.id}=`)),
      ).toBe(true);
    });
  });

  describe('logout', () => {
    it('ends the session immediately, access token included', async () => {
      const session = await login(testApp.app, credentials());

      await http().post('/api/v1/auth/logout').set(bearer(session.accessToken)).expect(204);

      const me = await http().get('/api/v1/auth/me').set(bearer(session.accessToken)).expect(401);
      expect(problem(me).code).toBe('SESSION_REVOKED');
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });

    it('can end a session with only its refresh token (access token already expired)', async () => {
      const session = await login(testApp.app, credentials());

      await http()
        .post('/api/v1/auth/logout')
        .send({ refreshToken: session.refreshToken })
        .expect(204);

      await http().get('/api/v1/auth/me').set(bearer(session.accessToken)).expect(401);
    });

    it('logout-all ends every session of the user at this school', async () => {
      const sessions = await Promise.all([1, 2, 3].map(() => login(testApp.app, credentials())));

      const response = await http()
        .post('/api/v1/auth/logout-all')
        .set(bearer(sessions[0]!.accessToken))
        .expect(200);

      expect((response.body as { sessionsRevoked: number }).sessionsRevoked).toBeGreaterThanOrEqual(
        3,
      );
      for (const session of sessions) {
        await http().get('/api/v1/auth/me').set(bearer(session.accessToken)).expect(401);
      }
    });
  });
});

function sessionIdOf(session: SessionBody): string {
  const payload = JSON.parse(
    Buffer.from(session.accessToken.split('.')[1]!, 'base64url').toString(),
  ) as { sid: string };
  return payload.sid;
}

function problemOf(response: request.Response): ProblemDetails {
  return response.body as ProblemDetails;
}
