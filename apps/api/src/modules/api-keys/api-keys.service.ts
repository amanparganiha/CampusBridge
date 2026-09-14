import type { Logger } from 'pino';
import { issueOpaqueToken, type ParsedOpaqueToken } from '../../auth/opaque-tokens.js';
import type { ApiKeyPrincipal, UserPrincipal } from '../../auth/principal.js';
import { PERMISSIONS, type Permission } from '../../authz/permissions.js';
import { requireTenantId } from '../../db/scope.js';
import type { TenantDb } from '../../db/tenant-db.js';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableError,
} from '../../lib/errors.js';
import type { AuditLogger } from '../audit/audit.service.js';

/** Scopes a key may never carry: a partner system must not be able to mint more keys. */
const UNGRANTABLE_SCOPES: ReadonlySet<Permission> = new Set(['apikey:manage']);

/** `lastUsedAt` is informational; write it at most this often per key. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface ApiKeyView {
  id: string;
  name: string;
  hint: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

const invalidKey = () =>
  new UnauthorizedError('The API key is invalid, expired or revoked.', { code: 'INVALID_API_KEY' });

function isPermission(scope: string): scope is Permission {
  return Object.hasOwn(PERMISSIONS, scope);
}

export class ApiKeyService {
  constructor(private readonly deps: { db: TenantDb; audit: AuditLogger; logger: Logger }) {}

  /** Resolves a presented key. The caller has already set the tenant context from the token. */
  async authenticate(parsed: ParsedOpaqueToken): Promise<ApiKeyPrincipal> {
    const key = await this.deps.db.client.apiKey.findUnique({
      where: { tenantId_keyHash: { tenantId: parsed.tenantId, keyHash: parsed.hash } },
    });
    const now = new Date();
    // Unknown (key is null), revoked or expired: all equally invalid.
    if (key?.revokedAt !== null || (key.expiresAt !== null && key.expiresAt <= now))
      throw invalidKey();

    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      await this.deps.db.client.apiKey
        .update({ where: { id: key.id }, data: { lastUsedAt: now } })
        .catch((err: unknown) => {
          this.deps.logger.warn({ err, apiKeyId: key.id }, 'could not record API key usage');
        });
    }

    return {
      kind: 'api_key',
      tenantId: key.tenantId,
      apiKeyId: key.id,
      permissions: new Set(key.scopes.filter(isPermission)),
    };
  }

  async create(
    principal: UserPrincipal,
    input: { name: string; scopes: readonly Permission[]; expiresAt?: Date | undefined },
  ): Promise<{ apiKey: ApiKeyView; token: string }> {
    const scopes = [...new Set(input.scopes)].sort();
    const ungrantable = scopes.filter((scope) => UNGRANTABLE_SCOPES.has(scope));
    if (ungrantable.length > 0) {
      throw new UnprocessableError(`API keys cannot carry: ${ungrantable.join(', ')}.`, {
        code: 'SCOPE_NOT_ALLOWED',
      });
    }
    // No privilege escalation: a key can only do what its creator can do.
    const beyondCreator = scopes.filter((scope) => !principal.permissions.has(scope));
    if (beyondCreator.length > 0) {
      throw new ForbiddenError(
        `You cannot grant scopes you do not hold: ${beyondCreator.join(', ')}.`,
        {
          code: 'SCOPE_NOT_GRANTABLE',
        },
      );
    }
    if (input.expiresAt && input.expiresAt <= new Date()) {
      throw new UnprocessableError('expiresAt must be in the future.', { code: 'INVALID_EXPIRY' });
    }

    const issued = issueOpaqueToken('cbk', requireTenantId('Creating an API key'));
    const apiKey = await this.deps.db.transaction(async (tx) => {
      const created = await tx.apiKey.create({
        data: {
          tenantId: requireTenantId(),
          name: input.name,
          prefix: issued.hint,
          keyHash: issued.hash,
          scopes,
          createdById: principal.userId,
          expiresAt: input.expiresAt ?? null,
        },
      });
      await this.deps.audit.record({
        action: 'apikey.created',
        resourceType: 'api_key',
        resourceId: created.id,
        metadata: { name: input.name, scopes },
      });
      return created;
    });

    return { apiKey: toView(apiKey), token: issued.token };
  }

  async list(): Promise<ApiKeyView[]> {
    const keys = await this.deps.db.client.apiKey.findMany({ orderBy: { id: 'desc' } });
    return keys.map(toView);
  }

  async revoke(id: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const revoked = await tx.apiKey.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count === 0) {
        const exists = await tx.apiKey.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw new NotFoundError('API key not found.');
        return; // already revoked: idempotent
      }
      await this.deps.audit.record({
        action: 'apikey.revoked',
        resourceType: 'api_key',
        resourceId: id,
      });
    });
  }
}

function toView(key: {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}): ApiKeyView {
  return {
    id: key.id,
    name: key.name,
    hint: key.prefix,
    scopes: key.scopes,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
  };
}
