import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export interface HealthRoutesOptions {
  checks: readonly ReadinessCheck[];
  isShuttingDown: () => boolean;
  /** Include failure messages in responses (non-production only; probes are public). */
  exposeErrors: boolean;
  timeoutMs?: number;
}

const checkResultSchema = z.object({
  status: z.enum(['ok', 'fail']),
  latencyMs: z.number(),
  error: z.string().optional(),
});

const readinessSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.record(z.string(), checkResultSchema),
});

type CheckResult = z.infer<typeof checkResultSchema>;

async function runCheck(
  check: ReadinessCheck,
  timeoutMs: number,
  exposeErrors: boolean,
): Promise<CheckResult> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check.check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }),
    ]);
    return { status: 'ok', latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      status: 'fail',
      latencyMs: Math.round(performance.now() - started),
      ...(exposeErrors ? { error: error instanceof Error ? error.message : String(error) } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness: the process is up and the event loop responds (container health check; failure
 * means restart). Readiness: dependencies are reachable and we are not draining (load balancer
 * health check; failure means stop routing traffic here, not restart). Keeping them separate
 * stops a database blip from triggering a restart storm.
 */
export const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (app, options) => {
  const { checks, isShuttingDown, exposeErrors, timeoutMs = 2000 } = options;
  const common = { tags: ['health'] };
  const probeConfig = { rateLimit: false } as const;

  app.get(
    '/health/live',
    {
      config: probeConfig,
      schema: {
        ...common,
        summary: 'Liveness probe',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  const readiness = async (): Promise<{
    ready: boolean;
    body: z.infer<typeof readinessSchema>;
  }> => {
    const results = await Promise.all(
      checks.map(
        async (check) => [check.name, await runCheck(check, timeoutMs, exposeErrors)] as const,
      ),
    );
    // While draining for shutdown, report unavailable so the load balancer stops routing here.
    const ready = results.every(([, result]) => result.status === 'ok') && !isShuttingDown();
    return {
      ready,
      body: { status: ready ? 'ok' : 'unavailable', checks: Object.fromEntries(results) },
    };
  };

  for (const url of ['/health/ready', '/health']) {
    app.get(
      url,
      {
        config: probeConfig,
        schema: {
          ...common,
          summary: url === '/health' ? 'Health summary (same as readiness)' : 'Readiness probe',
          response: { 200: readinessSchema, 503: readinessSchema },
        },
      },
      async (_request, reply) => {
        const { ready, body } = await readiness();
        return reply.status(ready ? 200 : 503).send(body);
      },
    );
  }
};
