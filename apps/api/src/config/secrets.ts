import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';
import { z } from 'zod';
import { encryptionKeysSchema, type EncryptionKeys } from '../lib/crypto/encryption.js';
import type { Env } from './env.js';

export interface SigningKeySet {
  keys: JWK[];
}

export interface AppSecrets {
  /** Private ES256 JWKs; the first one signs access tokens. */
  jwtPrivateJwks: SigningKeySet;
  encryptionKeys: EncryptionKeys;
}

const privateJwkSchema = z.looseObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  kid: z.string().min(1),
  d: z.string().min(1),
  x: z.string().min(1),
  y: z.string().min(1),
});
const signingKeySetSchema = z.object({ keys: z.array(privateJwkSchema).min(1) });

export async function generateSigningJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  const { d: _privatePart, ...publicPart } = jwk;
  return { ...jwk, kid: await calculateJwkThumbprint(publicPart), alg: 'ES256', use: 'sig' };
}

/** Fresh in-memory secrets (tests, first-run development). */
export async function generateSecrets(): Promise<AppSecrets> {
  return {
    jwtPrivateJwks: { keys: [await generateSigningJwk()] },
    encryptionKeys: { active: 'dev1', keys: { dev1: randomBytes(32).toString('base64') } },
  };
}

function parseJson<T>(name: string, raw: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `${name} is not valid: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Development convenience: secrets are generated once into a git-ignored file, so tokens and
 * encrypted rows survive dev-server restarts. Never used in production (env.ts requires the
 * variables there).
 */
async function readOrCreateDevSecrets(file: string): Promise<AppSecrets> {
  try {
    return parseJson(
      file,
      readFileSync(file, 'utf8'),
      z.object({
        jwtPrivateJwks: signingKeySetSchema,
        encryptionKeys: encryptionKeysSchema,
      }),
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      !(error instanceof Error && error.message.includes('ENOENT'))
    ) {
      throw error;
    }
  }
  const secrets = await generateSecrets();
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, JSON.stringify(secrets, null, 2), { flag: 'wx', mode: 0o600 });
    return secrets;
  } catch (error) {
    // Another process created it first: use theirs so both agree on the keys.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readOrCreateDevSecrets(file);
    throw error;
  }
}

export async function loadSecrets(
  env: Pick<Env, 'NODE_ENV' | 'JWT_PRIVATE_JWKS' | 'ENCRYPTION_KEYS'>,
  devSecretsFile = path.resolve('.cache', 'dev-secrets.json'),
): Promise<AppSecrets> {
  const fromEnv = {
    jwtPrivateJwks: env.JWT_PRIVATE_JWKS
      ? (parseJson('JWT_PRIVATE_JWKS', env.JWT_PRIVATE_JWKS, signingKeySetSchema) as SigningKeySet)
      : undefined,
    encryptionKeys: env.ENCRYPTION_KEYS
      ? parseJson('ENCRYPTION_KEYS', env.ENCRYPTION_KEYS, encryptionKeysSchema)
      : undefined,
  };
  if (fromEnv.jwtPrivateJwks && fromEnv.encryptionKeys) {
    return { jwtPrivateJwks: fromEnv.jwtPrivateJwks, encryptionKeys: fromEnv.encryptionKeys };
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('JWT_PRIVATE_JWKS and ENCRYPTION_KEYS are required in production');
  }
  const dev = await readOrCreateDevSecrets(devSecretsFile);
  return {
    jwtPrivateJwks: fromEnv.jwtPrivateJwks ?? dev.jwtPrivateJwks,
    encryptionKeys: fromEnv.encryptionKeys ?? dev.encryptionKeys,
  };
}
