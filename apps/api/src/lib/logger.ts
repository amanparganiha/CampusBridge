import { pino, type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';

/**
 * Structured JSON logs (one object per line) that CloudWatch Logs Insights, Loki or Datadog can
 * query without parsing. Secrets are redacted at the logger, so a stray `log.info({ body })`
 * cannot leak credentials or tokens.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.clientSecret',
  '*.apiKey',
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>, service: string): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service, env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  };

  if (env.NODE_ENV === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
    };
  } else {
    // String levels ("info") rather than numbers make log queries readable.
    options.formatters = { level: (label) => ({ level: label }) };
  }

  return pino(options);
}
