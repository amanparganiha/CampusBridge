import { z } from 'zod';

/**
 * Environment configuration, validated once at boot. Every process (API, worker, scripts)
 * reads configuration through `parseEnv` so a missing or malformed variable fails fast with
 * a readable message instead of surfacing later as an obscure runtime error.
 */

const commaSeparated = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const redisUrl = z.url({ protocol: /^rediss?$/ });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    PUBLIC_API_URL: z.url().default('http://localhost:4000'),
    ADMIN_URL: z.url().default('http://localhost:5173'),
    /** Honour X-Forwarded-* headers; enable only behind a trusted proxy (ALB/CloudFront). */
    TRUST_PROXY: z.stringbool().default(false),
    /** Extra browser origins allowed via CORS. The admin app is same-origin and needs none. */
    CORS_ORIGINS: commaSeparated.default([]),
    /**
     * On SIGTERM, report "not ready" for this long before closing, so the load balancer stops
     * sending new requests first. Set to a few seconds behind an ALB; 0 locally.
     */
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(0),

    /** Runtime role (`cb_app`): DML only, subject to row-level security. */
    DATABASE_URL: postgresUrl,
    /** Cross-tenant role (`cb_system`): used only by the worker's outbox relay and scanners. */
    SYSTEM_DATABASE_URL: postgresUrl.optional(),
    /** Table owner: used only by migrations and the role bootstrap script. */
    MIGRATE_DATABASE_URL: postgresUrl.optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    REDIS_URL: redisUrl,

    /** Bearer token required to scrape /metrics. */
    METRICS_TOKEN: z.string().min(16).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    if (!env.METRICS_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['METRICS_TOKEN'],
        message: 'is required in production',
      });
    }
    for (const key of ['PUBLIC_API_URL', 'ADMIN_URL'] as const) {
      if (!env[key].startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must use https in production' });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(error: z.ZodError) {
    super(`Invalid environment configuration:\n${z.prettifyError(error)}`);
    this.name = 'EnvValidationError';
    this.issues = error.issues;
  }
}

/**
 * Validates a set of environment variables. Empty strings are treated as unset so that
 * `FOO=` lines in a .env file fall back to defaults rather than failing validation.
 */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const defined = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(defined);
  if (!result.success) {
    throw new EnvValidationError(result.error);
  }
  return result.data;
}
