import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT, UnsecuredJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessTokenService } from '../../../src/auth/access-tokens.js';
import { generateSigningJwk } from '../../../src/config/secrets.js';
import { UnauthorizedError } from '../../../src/lib/errors.js';

const options = {
  issuer: 'https://api.campusbridge.test',
  audience: 'campusbridge-api',
  ttlSeconds: 900,
};
const claims = {
  userId: randomUUID(),
  tenantId: randomUUID(),
  sessionId: randomUUID(),
  roles: ['instructor'],
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UnauthorizedError) return error.code;
    throw error;
  }
  throw new Error('expected verification to fail');
}

describe('AccessTokenService', () => {
  let service: AccessTokenService;

  beforeAll(async () => {
    service = await AccessTokenService.create({ keys: [await generateSigningJwk()] }, options);
  });

  it('round-trips claims through an ES256 at+jwt token', async () => {
    const { token, expiresIn } = await service.sign(claims);
    const verified = await service.verify(token);

    expect(expiresIn).toBe(900);
    expect(verified).toMatchObject(claims);
    expect(verified.tokenId).toBeTruthy();
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as Record<
      string,
      string
    >;
    expect(header).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid: service.jwks.keys[0]!.kid });
  });

  it('publishes only public key material', () => {
    for (const key of service.jwks.keys) {
      expect(key).not.toHaveProperty('d');
      expect(key).toMatchObject({ kty: 'EC', alg: 'ES256', use: 'sig' });
    }
  });

  it('rejects expired tokens with a distinct code', async () => {
    vi.useFakeTimers();
    try {
      const { token } = await service.sign(claims);
      vi.setSystemTime(Date.now() + 901_000 + 5_000);
      expect(await codeOf(service.verify(token))).toBe('TOKEN_EXPIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a token whose payload was altered', async () => {
    const { token } = await service.sign(claims);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, sub: randomUUID(), roles: ['admin'] }),
    ).toString('base64url');

    expect(await codeOf(service.verify(`${header!}.${forgedPayload}.${signature!}`))).toBe(
      'TOKEN_INVALID',
    );
  });

  it('rejects unsigned ("alg": "none") tokens', async () => {
    const unsigned = new UnsecuredJWT({
      tid: claims.tenantId,
      sid: claims.sessionId,
      roles: ['admin'],
    })
      .setSubject(claims.userId)
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setExpirationTime('5m')
      .encode();

    expect(await codeOf(service.verify(unsigned))).toBe('TOKEN_INVALID');
  });

  it('rejects tokens signed by a key it does not trust', async () => {
    const attacker = await generateSigningJwk();
    const forged = await new SignJWT({
      tid: claims.tenantId,
      sid: claims.sessionId,
      roles: ['admin'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: attacker.kid!, typ: 'at+jwt' })
      .setSubject(claims.userId)
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(await importJWK(attacker, 'ES256'));

    expect(await codeOf(service.verify(forged))).toBe('TOKEN_INVALID');
  });

  it.each([
    ['another issuer', { ...options, issuer: 'https://evil.test' }],
    ['another audience', { ...options, audience: 'some-other-api' }],
  ])('rejects tokens minted for %s', async (_label, otherOptions) => {
    const keys = { keys: [await generateSigningJwk()] };
    const minted = await (await AccessTokenService.create(keys, otherOptions)).sign(claims);
    const verifier = await AccessTokenService.create(keys, options);

    expect(await codeOf(verifier.verify(minted.token))).toBe('TOKEN_INVALID');
  });

  it('refuses an ID token or other JWT that is not typed as an access token', async () => {
    const keys = { keys: [await generateSigningJwk()] };
    const verifier = await AccessTokenService.create(keys, options);
    const idToken = await new SignJWT({ tid: claims.tenantId, sid: claims.sessionId, roles: [] })
      .setProtectedHeader({ alg: 'ES256', kid: keys.keys[0]!.kid!, typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(await importJWK(keys.keys[0]!, 'ES256'));

    expect(await codeOf(verifier.verify(idToken))).toBe('TOKEN_INVALID');
  });

  it('keeps verifying tokens from a previous key after rotation', async () => {
    const oldKey = await generateSigningJwk();
    const before = await AccessTokenService.create({ keys: [oldKey] }, options);
    const { token } = await before.sign(claims);

    // Rotation: the new key is prepended (signs from now on); the old one stays for verification.
    const after = await AccessTokenService.create(
      { keys: [await generateSigningJwk(), oldKey] },
      options,
    );

    await expect(after.verify(token)).resolves.toMatchObject(claims);
  });
});
