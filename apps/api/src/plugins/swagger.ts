import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';
import type { Env } from '../config/env.js';

export interface SwaggerPluginOptions {
  env: Env;
}

/**
 * OpenAPI 3.1 generated from the same Zod schemas that validate requests and serialize
 * responses, so the published contract cannot drift from runtime behaviour. The admin app's
 * typed client is generated from /docs/json (see packages/api-client).
 */
const swaggerPluginImpl: FastifyPluginAsync<SwaggerPluginOptions> = async (app, { env }) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'CampusBridge API',
        version: '1.0.0',
        description:
          'Multi-tenant API for schools. Errors use RFC 9457 problem details ' +
          '(`application/problem+json`) with a stable `code`; list endpoints use cursor pagination.',
      },
      servers: [{ url: env.PUBLIC_API_URL }],
      tags: [
        { name: 'health', description: 'Liveness and readiness probes' },
        { name: 'auth', description: 'Sign-in, sessions, single sign-on and token keys' },
        { name: 'api-keys', description: 'Credentials for partner systems' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description:
              'An access token from /api/v1/auth/login (a short-lived JWT), or a partner API key (cbk_...).',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
    // Swagger UI needs its own CSP (the API default is `default-src 'none'`). Browsers would
    // upgrade http://localhost sub-resources to https and break the page, so that directive is
    // production-only.
    staticCSP: true,
    transformStaticCSP: (header) =>
      env.NODE_ENV === 'production' ? header : header.replace(/\s*upgrade-insecure-requests;?/, ''),
  });
};

export const swaggerPlugin = fp(swaggerPluginImpl, { name: 'swagger' });
