import type { PermissionResolver } from '../../auth/permission-resolver.js';
import { issueOpaqueToken, parseOpaqueToken } from '../../auth/opaque-tokens.js';
import type { Principal } from '../../auth/principal.js';
import { runAsTenant } from '../../context/request-context.js';
import { requireTenantId } from '../../db/scope.js';
import type { TenantDb } from '../../db/tenant-db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Encryptor } from '../../lib/crypto/encryption.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import type { AuditLogger } from '../audit/audit.service.js';
import type { AuthService, IssuedSession } from '../auth/auth.service.js';
import type { Outbox } from '../outbox/outbox.service.js';
import { assertCanGrantRoles } from './role-grants.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InvitationView {
  id: string;
  email: string;
  role: { key: string; name: string };
  status: InvitationStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

/** Binds an invitation token's ciphertext (carried in the outbox event) to that invitation. */
export const invitationTokenContext = (tenantId: string, invitationId: string) =>
  `invitation:${tenantId}:${invitationId}`;

const withRole = { role: { select: { key: true, name: true } } } as const;
type InvitationRow = Prisma.InvitationGetPayload<{ include: typeof withRole }>;

function statusOf(invitation: InvitationRow, now = new Date()): InvitationStatus {
  if (invitation.acceptedAt) return 'accepted';
  if (invitation.revokedAt) return 'revoked';
  return invitation.expiresAt <= now ? 'expired' : 'pending';
}

const toView = (invitation: InvitationRow): InvitationView => ({
  id: invitation.id,
  email: invitation.email,
  role: invitation.role,
  status: statusOf(invitation),
  expiresAt: invitation.expiresAt,
  acceptedAt: invitation.acceptedAt,
  createdAt: invitation.createdAt,
});

const invalidInvitation = () =>
  new NotFoundError('This invitation is invalid, has expired or was already used.', {
    code: 'INVITATION_INVALID',
  });

export class InvitationsService {
  constructor(
    private readonly deps: {
      db: TenantDb;
      audit: AuditLogger;
      outbox: Outbox;
      encryptor: Encryptor;
      auth: AuthService;
      permissions: PermissionResolver;
    },
  ) {}

  /**
   * Invites someone by email. The token exists in plaintext only inside the outbox event, and
   * even there it is encrypted and bound to this invitation, for the email worker to deliver.
   */
  async invite(
    principal: Principal,
    input: { email: string; roleKey: string },
  ): Promise<InvitationView> {
    const { db, audit, outbox, encryptor } = this.deps;
    const tenantId = requireTenantId('Inviting a user');
    const email = input.email.trim().toLowerCase();

    return db.transaction(async (tx) => {
      await assertCanGrantRoles(this.deps, principal, [input.roleKey]);
      const role = await tx.role.findUniqueOrThrow({
        where: { tenantId_key: { tenantId, key: input.roleKey } },
      });

      const existing = await tx.user.findUnique({ where: { tenantId_email: { tenantId, email } } });
      if (existing && existing.status !== 'invited') {
        throw new ConflictError('A user with this email already exists.', { code: 'USER_EXISTS' });
      }
      // Re-inviting replaces whatever invitation was still pending for this address.
      await tx.invitation.updateMany({
        where: { email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const issued = issueOpaqueToken('inv', tenantId);
      const invitation = await tx.invitation.create({
        data: {
          tenantId,
          email,
          roleId: role.id,
          tokenHash: issued.hash,
          invitedById: principal.kind === 'user' ? principal.userId : null,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
        include: withRole,
      });

      await audit.record({
        action: 'user.invited',
        resourceType: 'invitation',
        resourceId: invitation.id,
        metadata: { email, role: role.key },
      });
      await outbox.emit({
        type: 'user.invited',
        aggregateType: 'invitation',
        aggregateId: invitation.id,
        payload: {
          invitationId: invitation.id,
          email,
          role: role.key,
          expiresAt: invitation.expiresAt.toISOString(),
          tokenEnc: encryptor.encrypt(
            issued.token,
            invitationTokenContext(tenantId, invitation.id),
          ),
        },
      });
      return toView(invitation);
    });
  }

  async list(): Promise<InvitationView[]> {
    const invitations = await this.deps.db.client.invitation.findMany({
      orderBy: { id: 'desc' },
      include: withRole,
      take: 200,
    });
    return invitations.map(toView);
  }

  async revoke(id: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const invitation = await tx.invitation.findUnique({ where: { id }, include: withRole });
      if (!invitation) throw new NotFoundError('Invitation not found.');
      if (invitation.acceptedAt) {
        throw new ConflictError('This invitation was already accepted.', {
          code: 'INVITATION_ACCEPTED',
        });
      }
      if (invitation.revokedAt) return;
      await tx.invitation.update({ where: { id }, data: { revokedAt: new Date() } });
      await this.deps.audit.record({
        action: 'invitation.revoked',
        resourceType: 'invitation',
        resourceId: id,
        metadata: { email: invitation.email },
      });
    });
  }

  /** What the acceptance page may show before the person sets a password. */
  async lookup(token: string) {
    const parsed = parseOpaqueToken(token, 'inv');
    if (!parsed) throw invalidInvitation();
    return runAsTenant(parsed.tenantId, async () => {
      const invitation = await this.#pending(parsed.tenantId, parsed.hash);
      const tenant = await this.deps.db.client.tenant.findUniqueOrThrow({
        where: { id: parsed.tenantId },
        select: { name: true, slug: true, status: true },
      });
      if (tenant.status !== 'active') throw invalidInvitation();
      return {
        tenant: { name: tenant.name, slug: tenant.slug },
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      };
    });
  }

  /** Creates (or activates) the account, grants the invited role and signs the person in. */
  async accept(token: string, input: { name: string; password: string }): Promise<IssuedSession> {
    const parsed = parseOpaqueToken(token, 'inv');
    if (!parsed) throw invalidInvitation();
    const passwordHash = await hashPassword(input.password);

    return runAsTenant(parsed.tenantId, async () => {
      const { db, audit } = this.deps;
      const tenantId = parsed.tenantId;
      const tenant = await db.client.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { status: true },
      });
      if (tenant.status !== 'active') throw invalidInvitation();

      const user = await db.transaction(async (tx) => {
        const invitation = await this.#pending(tenantId, parsed.hash);
        // Single use: of two concurrent acceptances, exactly one claims the invitation.
        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, acceptedAt: null, revokedAt: null },
          data: { acceptedAt: new Date() },
        });
        if (claimed.count !== 1) throw invalidInvitation();

        const existing = await tx.user.findUnique({
          where: { tenantId_email: { tenantId, email: invitation.email } },
        });
        if (existing && existing.status !== 'invited') {
          throw new ConflictError('An account with this email already exists. Sign in instead.', {
            code: 'USER_EXISTS',
          });
        }
        const account = existing
          ? await tx.user.update({
              where: { id: existing.id },
              data: { name: input.name, passwordHash, status: 'active' },
            })
          : await tx.user.create({
              data: {
                tenantId,
                email: invitation.email,
                name: input.name,
                passwordHash,
                status: 'active',
              },
            });
        await tx.userRole.upsert({
          where: {
            tenantId_userId_roleId: { tenantId, userId: account.id, roleId: invitation.roleId },
          },
          create: {
            tenantId,
            userId: account.id,
            roleId: invitation.roleId,
            grantedById: invitation.invitedById,
          },
          update: {},
        });
        await tx.invitation.update({
          where: { id: invitation.id },
          data: { acceptedUserId: account.id },
        });
        await audit.record({
          action: 'invitation.accepted',
          resourceType: 'invitation',
          resourceId: invitation.id,
          actor: { type: 'user', id: account.id },
          metadata: { email: invitation.email, role: invitation.role.key },
        });
        return account;
      });

      return this.deps.auth.startSession(user, 'invitation');
    });
  }

  async #pending(tenantId: string, tokenHash: string): Promise<InvitationRow> {
    const invitation = await this.deps.db.client.invitation.findUnique({
      where: { tenantId_tokenHash: { tenantId, tokenHash } },
      include: withRole,
    });
    if (!invitation || statusOf(invitation) !== 'pending') throw invalidInvitation();
    return invitation;
  }
}
