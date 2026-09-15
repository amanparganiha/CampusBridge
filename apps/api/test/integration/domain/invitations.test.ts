import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProblemDetails } from '../../../src/lib/errors.js';
import { invitationTokenContext } from '../../../src/modules/users/invitations.service.js';
import { bearer, startTestApp, type SessionBody, type TestApp } from '../helpers/app.js';
import { connectTestDatabases, createTestUser, type TestDatabases } from '../helpers/database.js';
import {
  as,
  createActor,
  createSchool,
  signIn,
  type Actor,
  type SchoolFixture,
} from '../helpers/school.js';

interface InvitationBody {
  id: string;
  email: string;
  role: { key: string; name: string };
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

const problem = (response: { body: unknown }) => response.body as ProblemDetails;

describe('invitations', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: SchoolFixture;

  const http = () => request(testApp.app.server);
  const invite = (actor: Actor, body: { email: string; role: string }, key?: string) => {
    const call = as(testApp.app, actor).post('/api/v1/users/invite');
    return (key ? call.set('idempotency-key', key) : call).send(body);
  };

  /** The token the email worker would deliver, recovered from the outbox event. */
  async function tokenFor(invitationId: string): Promise<string> {
    const event = await dbs.owner.outboxEvent.findFirstOrThrow({
      where: { tenantId: school.id, type: 'user.invited', aggregateId: invitationId },
    });
    const { tokenEnc } = event.payload as { tokenEnc: string };
    return testApp.container.encryptor.decrypt(
      tokenEnc,
      invitationTokenContext(school.id, invitationId),
    );
  }

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    school = await createSchool(dbs, testApp.app, 'invites');
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  it('invites by email and lets the invitee create their account and sign in', async () => {
    const created = await invite(school.admin, {
      email: 'New.Teacher@Invites.test',
      role: 'instructor',
    }).expect(201);
    const invitation = created.body as InvitationBody;
    expect(invitation).toMatchObject({
      email: 'new.teacher@invites.test',
      role: { key: 'instructor' },
      status: 'pending',
    });

    // The token exists only encrypted in the outbox event; the database keeps its hash.
    const token = await tokenFor(invitation.id);
    expect(token).toMatch(new RegExp(`^inv_${school.id}_`));
    const event = await dbs.owner.outboxEvent.findFirstOrThrow({
      where: { aggregateId: invitation.id },
    });
    expect(JSON.stringify(event.payload)).not.toContain(token);
    const stored = await dbs.owner.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(stored.tokenHash).not.toContain(token);

    const lookup = await http().post('/api/v1/auth/invitations/lookup').send({ token }).expect(200);
    expect(lookup.body).toMatchObject({
      tenant: { slug: school.slug },
      email: 'new.teacher@invites.test',
      role: { key: 'instructor' },
    });

    const accepted = await http()
      .post('/api/v1/auth/invitations/accept')
      .send({
        token,
        name: 'New Teacher',
        password: 'a long enough passphrase',
        tokenDelivery: 'body',
      })
      .expect(200);
    const session = accepted.body as SessionBody;
    expect(session.roles).toEqual(['instructor']);
    expect(session.tenant.id).toBe(school.id);

    const me = await http().get('/api/v1/auth/me').set(bearer(session.accessToken)).expect(200);
    expect(me.body).toMatchObject({
      user: { email: 'new.teacher@invites.test', name: 'New Teacher' },
    });

    // Single use.
    const again = await http()
      .post('/api/v1/auth/invitations/accept')
      .send({
        token,
        name: 'Someone Else',
        password: 'another long passphrase',
        tokenDelivery: 'body',
      })
      .expect(404);
    expect(problem(again).code).toBe('INVITATION_INVALID');

    const listed = (await as(testApp.app, school.admin).get('/api/v1/invitations').expect(200))
      .body as {
      data: InvitationBody[];
    };
    expect(listed.data.find((entry) => entry.id === invitation.id)?.status).toBe('accepted');

    const trail = await dbs.owner.auditLog.findMany({
      where: { tenantId: school.id, resourceId: invitation.id },
      orderBy: { id: 'asc' },
    });
    expect(trail.map((entry) => [entry.action, entry.actorId])).toEqual([
      ['user.invited', school.admin.id],
      ['invitation.accepted', session.user.id],
    ]);
  });

  it('sets the refresh cookie when accepting in a browser', async () => {
    const invitation = (
      await invite(school.admin, { email: 'cookie@invites.test', role: 'student' }).expect(201)
    ).body as InvitationBody;
    const response = await http()
      .post('/api/v1/auth/invitations/accept')
      .send({
        token: await tokenFor(invitation.id),
        name: 'Cookie',
        password: 'a long enough passphrase',
      })
      .expect(200);

    expect((response.body as SessionBody).refreshToken).toBeUndefined();
    expect(String(response.headers['set-cookie'])).toContain(`cb_rt_${school.id}=`);
  });

  it('replaces a pending invitation when the same address is invited again', async () => {
    const first = (
      await invite(school.admin, { email: 'twice@invites.test', role: 'student' }).expect(201)
    ).body as InvitationBody;
    const firstToken = await tokenFor(first.id);
    const second = (
      await invite(school.admin, { email: 'twice@invites.test', role: 'instructor' }).expect(201)
    ).body as InvitationBody;

    await http().post('/api/v1/auth/invitations/lookup').send({ token: firstToken }).expect(404);
    await http()
      .post('/api/v1/auth/invitations/lookup')
      .send({ token: await tokenFor(second.id) })
      .expect(200);
  });

  it('can be revoked until it is accepted', async () => {
    const invitation = (
      await invite(school.admin, { email: 'revoked@invites.test', role: 'student' }).expect(201)
    ).body as InvitationBody;
    const token = await tokenFor(invitation.id);

    await as(testApp.app, school.admin).delete(`/api/v1/invitations/${invitation.id}`).expect(204);
    await as(testApp.app, school.admin).delete(`/api/v1/invitations/${invitation.id}`).expect(204);
    const refused = await http()
      .post('/api/v1/auth/invitations/accept')
      .send({
        token,
        name: 'Too Late',
        password: 'a long enough passphrase',
        tokenDelivery: 'body',
      })
      .expect(404);
    expect(problem(refused).code).toBe('INVITATION_INVALID');
  });

  it('refuses existing members, weak passwords and tampered tokens', async () => {
    const existing = await invite(school.admin, {
      email: school.student.email,
      role: 'student',
    }).expect(409);
    expect(problem(existing).code).toBe('USER_EXISTS');

    const invitation = (
      await invite(school.admin, { email: 'weak@invites.test', role: 'student' }).expect(201)
    ).body as InvitationBody;
    const token = await tokenFor(invitation.id);
    await http()
      .post('/api/v1/auth/invitations/accept')
      .send({ token, name: 'Weak', password: 'short', tokenDelivery: 'body' })
      .expect(400);

    const other = await createSchool(dbs, testApp.app, 'invites-other');
    await http()
      .post('/api/v1/auth/invitations/lookup')
      .send({ token: token.replace(school.id, other.id) })
      .expect(404);
    await http().post('/api/v1/auth/invitations/lookup').send({ token: 'inv_garbage' }).expect(404);
  });

  it('cannot be used to hand out roles the inviter does not hold', async () => {
    const role = await dbs.owner.role.create({
      data: { tenantId: school.id, key: 'recruiter', name: 'Recruiter' },
    });
    await dbs.owner.rolePermission.createMany({
      data: [
        'user:invite',
        'tenant:read',
        'course:read',
        'enrollment:read',
        'enrollment:self',
        'grade:read',
        'payment:read',
        'payment:create',
        'file:read',
      ].map((permissionKey) => ({
        tenantId: school.id,
        roleId: role.id,
        permissionKey,
      })),
    });
    const user = await createTestUser(dbs.owner, school.tenant, { role: 'student' });
    await dbs.owner.userRole.create({
      data: { tenantId: school.id, userId: user.id, roleId: role.id },
    });
    const recruiter = await signIn(testApp.app, school.tenant, user);

    const response = await invite(recruiter, { email: 'boss@invites.test', role: 'admin' }).expect(
      403,
    );
    expect(problem(response).code).toBe('ROLE_NOT_GRANTABLE');
    await invite(recruiter, { email: 'pupil@invites.test', role: 'student' }).expect(201);
  });

  describe('with an Idempotency-Key', () => {
    it('replays the original response instead of inviting twice', async () => {
      const key = `invite-${randomUUID()}`;
      const body = { email: 'retry@invites.test', role: 'student' };
      const first = await invite(school.admin, body, key).expect(201);
      const retry = await invite(school.admin, body, key).expect(201);

      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(
        await dbs.owner.invitation.count({
          where: { tenantId: school.id, email: 'retry@invites.test' },
        }),
      ).toBe(1);
    });

    it('rejects the same key for a different request', async () => {
      const key = `invite-${randomUUID()}`;
      await invite(school.admin, { email: 'one@invites.test', role: 'student' }, key).expect(201);
      const reused = await invite(
        school.admin,
        { email: 'two@invites.test', role: 'student' },
        key,
      ).expect(422);
      expect(problem(reused).code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('scopes keys to the caller, so two administrators never collide', async () => {
      const key = `invite-${randomUUID()}`;
      const otherAdmin = await createActor(dbs, testApp.app, school.tenant, 'admin');
      const mine = await invite(
        school.admin,
        { email: 'scoped@invites.test', role: 'student' },
        key,
      ).expect(201);
      const theirs = await invite(
        otherAdmin,
        { email: 'scoped@invites.test', role: 'student' },
        key,
      ).expect(201);

      expect(theirs.headers['idempotent-replayed']).toBeUndefined();
      expect((theirs.body as InvitationBody).id).not.toBe((mine.body as InvitationBody).id);
    });

    it('rejects malformed keys', async () => {
      const response = await invite(
        school.admin,
        { email: 'bad-key@invites.test', role: 'student' },
        'has space',
      ).expect(400);
      expect(problem(response).code).toBe('INVALID_IDEMPOTENCY_KEY');
    });
  });
});
