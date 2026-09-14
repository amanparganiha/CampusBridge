import { setTimeout as sleep } from 'node:timers/promises';
import closeWithGrace from 'close-with-grace';
import { buildApp } from './app.js';
import { EnvValidationError, parseEnv, type Env } from './config/env.js';
import { createContainer } from './container.js';

function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const env = loadEnv();
const container = createContainer(env);
const app = await buildApp(container);

// SIGTERM (ECS task stop, Ctrl+C locally): stop reporting ready, let the load balancer drain,
// finish in-flight requests, then release connections. A second signal or the delay expiring
// forces exit.
closeWithGrace(
  { delay: 10_000 + env.SHUTDOWN_DRAIN_MS, logger: container.logger },
  async ({ signal, err }) => {
    if (err) {
      container.logger.fatal({ err }, 'shutting down after unrecoverable error');
    } else {
      container.logger.info({ signal }, 'shutdown requested');
    }
    container.lifecycle.beginShutdown();
    if (env.SHUTDOWN_DRAIN_MS > 0) await sleep(env.SHUTDOWN_DRAIN_MS);
    await app.close();
    await container.close();
    container.logger.info('shutdown complete');
  },
);

await app.listen({ host: env.API_HOST, port: env.API_PORT });
