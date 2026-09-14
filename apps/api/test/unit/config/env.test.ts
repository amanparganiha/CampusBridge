import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../../../src/config/env.js';

const minimal = {
  DATABASE_URL: 'postgresql://cb_app:secret@localhost:5433/campusbridge',
  REDIS_URL: 'redis://localhost:6379',
};

function captureError(fn: () => unknown): EnvValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected parseEnv to throw');
}

describe('parseEnv', () => {
  it('accepts the committed .env.example, so the example never drifts from the schema', () => {
    const example = readFileSync(new URL('../../../../../.env.example', import.meta.url), 'utf8');

    const env = parseEnv(parseDotenv(example));

    expect(env.API_PORT).toBe(4000);
    expect(env.DATABASE_URL).toContain('cb_app');
  });

  it('applies defaults for optional settings', () => {
    const env = parseEnv(minimal);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_PORT: 4000,
      TRUST_PROXY: false,
      CORS_ORIGINS: [],
      DB_POOL_MAX: 10,
    });
  });

  it('treats empty strings as unset', () => {
    const env = parseEnv({ ...minimal, API_PORT: '', CORS_ORIGINS: '' });

    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('coerces numbers, booleans and comma-separated lists', () => {
    const env = parseEnv({
      ...minimal,
      API_PORT: '8080',
      TRUST_PROXY: 'true',
      CORS_ORIGINS: 'https://a.example, https://b.example,',
    });

    expect(env.API_PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('reports every invalid variable in a single error', () => {
    const error = captureError(() =>
      parseEnv({
        DATABASE_URL: 'mysql://root@localhost/db',
        REDIS_URL: 'not-a-url',
        API_PORT: '70000',
      }),
    );

    const paths = error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['DATABASE_URL', 'REDIS_URL', 'API_PORT']));
    expect(error.message).toContain('Invalid environment configuration');
  });

  it('enforces production-only invariants', () => {
    const error = captureError(() =>
      parseEnv({
        ...minimal,
        NODE_ENV: 'production',
        PUBLIC_API_URL: 'http://api.example.com',
        ADMIN_URL: 'https://admin.example.com',
      }),
    );

    const paths = error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['METRICS_TOKEN', 'PUBLIC_API_URL']));
    expect(paths).not.toContain('ADMIN_URL');
  });
});
