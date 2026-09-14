import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, errors, importJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import { z } from 'zod';
import type { SigningKeySet } from '../config/secrets.js';
import { UnauthorizedError } from '../lib/errors.js';

/**
 * Short-lived access tokens: ES256-signed JWTs typed `at+jwt` (RFC 9068).
 *
 * Asymmetric signing lets other services verify tokens with the public keys at
 * /.well-known/jwks.json without ever holding a signing secret. Tokens are stateless for speed,
 * but carry the session id so a revoked session is rejected immediately (see authenticate.ts).
 */

export interface AccessTokenClaims {
  userId: string;
  tenantId: string;
  sessionId: string;
  /** Role keys at issue time; permissions are resolved from them per request. */
  roles: string[];
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  tokenId: string;
  expiresAt: Date;
}

export interface AccessTokenOptions {
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

const ALGORITHM = 'ES256';
const TOKEN_TYPE = 'at+jwt';

const payloadSchema = z.object({
  sub: z.uuid(),
  tid: z.uuid(),
  sid: z.uuid(),
  roles: z.array(z.string()),
  jti: z.string().min(1),
  exp: z.number(),
});

export class AccessTokenService {
  private constructor(
    private readonly signingKey: Awaited<ReturnType<typeof importJWK>>,
    private readonly signingKeyId: string,
    private readonly publicKeys: JWK[],
    private readonly options: AccessTokenOptions,
  ) {}

  static async create(
    keySet: SigningKeySet,
    options: AccessTokenOptions,
  ): Promise<AccessTokenService> {
    const [signing] = keySet.keys;
    if (!signing?.kid)
      throw new Error('The signing key set must contain at least one key with a kid');
    const publicKeys = keySet.keys.map(({ d: _privatePart, ...publicPart }) => ({
      ...publicPart,
      alg: ALGORITHM,
      use: 'sig',
    }));
    return new AccessTokenService(
      await importJWK(signing, ALGORITHM),
      signing.kid,
      publicKeys,
      options,
    );
  }

  /** Public half of every configured key, for /.well-known/jwks.json. */
  get jwks(): { keys: JWK[] } {
    return { keys: this.publicKeys };
  }

  get ttlSeconds(): number {
    return this.options.ttlSeconds;
  }

  async sign(claims: AccessTokenClaims): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({
      tid: claims.tenantId,
      sid: claims.sessionId,
      roles: claims.roles,
    })
      .setProtectedHeader({ alg: ALGORITHM, kid: this.signingKeyId, typ: TOKEN_TYPE })
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setSubject(claims.userId)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${String(this.options.ttlSeconds)}s`)
      .sign(this.signingKey);
    return { token, expiresIn: this.options.ttlSeconds };
  }

  /** Throws UnauthorizedError (code TOKEN_EXPIRED or TOKEN_INVALID) for any unusable token. */
  async verify(token: string): Promise<VerifiedAccessToken> {
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: this.publicKeys }), {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: [ALGORITHM],
        typ: TOKEN_TYPE,
        clockTolerance: 5,
        requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      });
      const claims = payloadSchema.parse(payload);
      return {
        userId: claims.sub,
        tenantId: claims.tid,
        sessionId: claims.sid,
        roles: claims.roles,
        tokenId: claims.jti,
        expiresAt: new Date(claims.exp * 1000),
      };
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        throw new UnauthorizedError('The access token has expired.', {
          code: 'TOKEN_EXPIRED',
          cause: error,
        });
      }
      throw new UnauthorizedError('The access token is invalid.', {
        code: 'TOKEN_INVALID',
        cause: error,
      });
    }
  }
}
