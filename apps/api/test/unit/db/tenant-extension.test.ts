import { describe, expect, it } from 'vitest';
import { CrossTenantAccessError, scopeArgs } from '../../../src/db/tenant-extension.js';

const TENANT = '01a09e9a-4173-77ad-97f4-aa5db3ef9ff7';
const OTHER = '01a09e9a-41bf-74ef-8389-5e48f128e043';

describe('scopeArgs', () => {
  describe('filters', () => {
    it.each([
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'count',
      'aggregate',
      'groupBy',
      'delete',
      'deleteMany',
    ])('adds the tenant to %s filters', (operation) => {
      expect(scopeArgs('Course', operation, { where: { id: 'c1' } }, TENANT)).toEqual({
        where: { id: 'c1', tenantId: TENANT },
      });
    });

    it('scopes operations that have no filter at all', () => {
      expect(scopeArgs('Course', 'findMany', undefined, TENANT)).toEqual({
        where: { tenantId: TENANT },
      });
    });

    it('accepts a filter that already names the current tenant', () => {
      expect(scopeArgs('Course', 'findMany', { where: { tenantId: TENANT } }, TENANT)).toEqual({
        where: { tenantId: TENANT },
      });
    });

    it.each([
      ['another tenant', { tenantId: OTHER }],
      ['a tenant range', { tenantId: { in: [TENANT, OTHER] } }],
      [
        'a compound key for another tenant',
        { tenantId_email: { tenantId: OTHER, email: 'a@b.test' } },
      ],
    ])('refuses a filter naming %s', (_label, where) => {
      expect(() => scopeArgs('User', 'findUnique', { where }, TENANT)).toThrow(
        CrossTenantAccessError,
      );
    });

    it('does not mutate the caller’s arguments', () => {
      const args = { where: { id: 'c1' } };

      scopeArgs('Course', 'findMany', args, TENANT);

      expect(args).toEqual({ where: { id: 'c1' } });
    });
  });

  describe('creates', () => {
    it('stamps the tenant onto a new row', () => {
      expect(scopeArgs('Course', 'create', { data: { title: 'T' } }, TENANT)).toEqual({
        data: { title: 'T', tenantId: TENANT },
      });
    });

    it('stamps every row of a bulk create', () => {
      expect(
        scopeArgs('Role', 'createMany', { data: [{ key: 'a' }, { key: 'b' }] }, TENANT),
      ).toEqual({
        data: [
          { key: 'a', tenantId: TENANT },
          { key: 'b', tenantId: TENANT },
        ],
      });
    });

    it('refuses rows for another tenant, including one bad row in a batch', () => {
      expect(() => scopeArgs('Course', 'create', { data: { tenantId: OTHER } }, TENANT)).toThrow(
        CrossTenantAccessError,
      );
      expect(() =>
        scopeArgs(
          'Role',
          'createManyAndReturn',
          { data: [{ tenantId: TENANT }, { tenantId: OTHER }] },
          TENANT,
        ),
      ).toThrow(CrossTenantAccessError);
    });

    it('refuses connecting the tenant relation directly', () => {
      expect(() =>
        scopeArgs('Course', 'create', { data: { tenant: { connect: { id: OTHER } } } }, TENANT),
      ).toThrow(/tenant relation/);
    });
  });

  describe('updates', () => {
    it.each(['update', 'updateMany', 'updateManyAndReturn'])(
      'scopes %s and allows ordinary changes',
      (operation) => {
        expect(
          scopeArgs('Course', operation, { where: { id: 'c1' }, data: { title: 'New' } }, TENANT),
        ).toEqual({
          where: { id: 'c1', tenantId: TENANT },
          data: { title: 'New' },
        });
      },
    );

    it('refuses to move a row to another tenant', () => {
      expect(() =>
        scopeArgs('Course', 'update', { where: { id: 'c1' }, data: { tenantId: OTHER } }, TENANT),
      ).toThrow(/cannot be changed/);
    });

    it('scopes all three parts of an upsert', () => {
      expect(
        scopeArgs(
          'Role',
          'upsert',
          { where: { id: 'r1' }, create: { key: 'k' }, update: { name: 'N' } },
          TENANT,
        ),
      ).toEqual({
        where: { id: 'r1', tenantId: TENANT },
        create: { key: 'k', tenantId: TENANT },
        update: { name: 'N' },
      });
      expect(() =>
        scopeArgs('Role', 'upsert', { where: {}, create: {}, update: { tenantId: OTHER } }, TENANT),
      ).toThrow(CrossTenantAccessError);
    });
  });

  it('fails closed on operations it does not know', () => {
    expect(() => scopeArgs('Course', 'findRaw', {}, TENANT)).toThrow(/not supported/);
  });
});
