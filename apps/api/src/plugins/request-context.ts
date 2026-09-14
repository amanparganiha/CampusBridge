import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import { runWithContext, type RequestContext } from '../context/request-context.js';

declare module 'fastify' {
  interface FastifyRequest {
    context: RequestContext;
  }
}

const TRUSTED_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Reuses a caller-supplied `x-request-id` (e.g. from a partner system or gateway) so a request
 * can be followed across services, but only when it is well-formed: ids end up in logs, so
 * arbitrary input would enable log injection.
 */
export function generateRequestId(request: IncomingMessage): string {
  const inbound = request.headers['x-request-id'];
  return typeof inbound === 'string' && TRUSTED_REQUEST_ID.test(inbound) ? inbound : randomUUID();
}

const requestContextPluginImpl: FastifyPluginCallback = (app, _options, done) => {
  app.decorateRequest('context', null as unknown as RequestContext);

  app.addHook('onRequest', (request, reply, next) => {
    void reply.header('x-request-id', request.id);
    request.context = {
      requestId: request.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    };
    runWithContext(request.context, next);
  });

  // The body is parsed from socket events that fire outside the onRequest scope, so the async
  // context must be re-entered afterwards for handlers to see it. Same object, same state.
  app.addHook('preValidation', (request, _reply, next) => {
    runWithContext(request.context, next);
  });

  done();
};

export const requestContextPlugin = fp(requestContextPluginImpl, { name: 'request-context' });
