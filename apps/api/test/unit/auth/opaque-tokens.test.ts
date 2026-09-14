import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueOpaqueToken, parseOpaqueToken } from '../../../src/auth/opaque-tokens.js';

const tenantId = randomUUID();

describe('opaque tokens', () => {
  it('embeds the tenant for routing and stores only a hash', () => {
    const issued = issueOpaqueToken('rt', tenantId);

    expect(issued.token).toMatch(new RegExp(`^rt_${tenantId}_[A-Za-z0-9_-]{43}$`));
    expect(issued.hash).not.toContain(issued.token.split('_').at(-1));
    expect(parseOpaqueToken(issued.token, 'rt')).toEqual({ tenantId, hash: issued.hash });
  });

  it('never repeats a secret', () => {
    const tokens = new Set(
      Array.from({ length: 1000 }, () => issueOpaqueToken('cbk', tenantId).token),
    );

    expect(tokens.size).toBe(1000);
  });

  it('rejects a token of another kind, so an API key cannot be used as a refresh token', () => {
    const apiKey = issueOpaqueToken('cbk', tenantId).token;

    expect(parseOpaqueToken(apiKey, 'rt')).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['garbage', 'not-a-token'],
    ['a JWT', 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig'],
    ['a truncated secret', `rt_${tenantId}_short`],
    ['an uppercase tenant id', `rt_${tenantId.toUpperCase()}_${'a'.repeat(43)}`],
  ])('rejects %s', (_label, token) => {
    expect(parseOpaqueToken(token, 'rt')).toBeNull();
  });

  it('changes the hash when the tenant part is tampered with, so the lookup misses', () => {
    const issued = issueOpaqueToken('rt', tenantId);
    const tampered = issued.token.replace(tenantId, randomUUID());

    expect(parseOpaqueToken(tampered, 'rt')?.hash).not.toBe(issued.hash);
  });
});
