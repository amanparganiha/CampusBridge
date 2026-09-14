import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { Prisma } from '../generated/prisma/client.js';
import {
  AppError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  ValidationError,
  toProblem,
  type FieldError,
} from '../lib/errors.js';

/** Maps anything thrown during a request onto the API's error vocabulary. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (hasZodFastifySchemaValidationErrors(error)) {
    const location = error.validationContext ?? 'request';
    const errors: FieldError[] = error.validation.map((issue) => ({
      path: [location, ...issue.instancePath.split('/').filter(Boolean)].join('.'),
      message: issue.message ?? 'Invalid value',
    }));
    return new ValidationError(errors);
  }

  // Our response did not match its own schema: a server bug, never the client's fault.
  if (isResponseSerializationError(error)) {
    return new InternalServerError({ cause: error });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return fromPrismaError(error);
  }

  // Framework-level client errors (malformed JSON, 413, 415...). Keep Fastify's human-readable
  // message but expose a status-derived code, not framework internals like FST_ERR_CTP_*.
  if (isFastifyClientError(error)) {
    const code = (STATUS_CODES[error.statusCode] ?? 'Bad Request')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_');
    return new AppError(error.statusCode, code, error.message, { cause: error });
  }

  return new InternalServerError({ cause: error });
}

function fromPrismaError(error: Prisma.PrismaClientKnownRequestError): AppError {
  switch (error.code) {
    case 'P2002': {
      const fields = uniqueConstraintFields(error.meta);
      const detail = fields.length
        ? `A record with the same ${fields.join(', ')} already exists.`
        : 'A record with the same unique values already exists.';
      return new ConflictError(detail, { code: 'ALREADY_EXISTS', cause: error });
    }
    case 'P2025':
      return new NotFoundError(undefined, { cause: error });
    case 'P2003':
      return new ConflictError(
        'The operation references a record that does not exist or is still in use.',
        {
          code: 'REFERENCE_CONFLICT',
          cause: error,
        },
      );
    default:
      return new InternalServerError({ cause: error });
  }
}

/** Driver adapters report the violated columns in a different place than the legacy engine. */
function uniqueConstraintFields(meta: Record<string, unknown> | undefined): string[] {
  const target = meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];

  const adapterError = meta?.driverAdapterError as
    { cause?: { constraint?: { fields?: unknown } } } | undefined;
  const fields = adapterError?.cause?.constraint?.fields;
  return Array.isArray(fields) ? fields.map(String) : [];
}

function isFastifyClientError(error: unknown): error is FastifyError & { statusCode: number } {
  if (!(error instanceof Error)) return false;
  const { statusCode, code } = error as Partial<FastifyError>;
  return (
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500 &&
    typeof code === 'string' &&
    STATUS_CODES[statusCode] !== undefined
  );
}

const errorHandlerPluginImpl: FastifyPluginCallback = (app, _options, done) => {
  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    if (appError.status >= 500) {
      request.log.error({ err: error, code: appError.code }, 'request failed');
    } else {
      request.log.info({ code: appError.code, status: appError.status }, 'request rejected');
    }

    return reply
      .status(appError.status)
      .headers(appError.headers)
      .type('application/problem+json')
      .send(toProblem(appError, { requestId: request.id, instance: request.url }));
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError(`No route matches ${request.method} ${request.url}.`, {
      code: 'ROUTE_NOT_FOUND',
    });
    return reply
      .status(404)
      .type('application/problem+json')
      .send(toProblem(error, { requestId: request.id, instance: request.url }));
  });

  done();
};

export const errorHandlerPlugin = fp(errorHandlerPluginImpl, { name: 'error-handler' });
