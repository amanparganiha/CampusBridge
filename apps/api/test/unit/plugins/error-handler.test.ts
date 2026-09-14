import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../src/generated/prisma/client.js';
import { AppError, NotFoundError } from '../../../src/lib/errors.js';
import { toAppError } from '../../../src/plugins/error-handler.js';

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('prisma failure', {
    code,
    clientVersion: 'test',
    meta,
  });
}

describe('toAppError', () => {
  it('passes application errors through unchanged', () => {
    const error = new NotFoundError('Course not found.');

    expect(toAppError(error)).toBe(error);
  });

  it('maps unique violations to 409 ALREADY_EXISTS, naming the fields (legacy meta)', () => {
    const mapped = toAppError(prismaError('P2002', { target: ['tenant_id', 'email'] }));

    expect(mapped).toMatchObject({ status: 409, code: 'ALREADY_EXISTS' });
    expect(mapped.message).toContain('tenant_id, email');
  });

  it('reads the violated fields from driver-adapter metadata (Prisma 7)', () => {
    const mapped = toAppError(
      prismaError('P2002', {
        driverAdapterError: {
          cause: { kind: 'UniqueConstraintViolation', constraint: { fields: ['slug'] } },
        },
      }),
    );

    expect(mapped.message).toContain('slug');
  });

  it('maps a missing record to 404 and a broken reference to 409', () => {
    expect(toAppError(prismaError('P2025'))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(toAppError(prismaError('P2003'))).toMatchObject({
      status: 409,
      code: 'REFERENCE_CONFLICT',
    });
  });

  it('treats unrecognised database errors as internal errors', () => {
    expect(toAppError(prismaError('P2010'))).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  it('keeps framework client errors but hides framework-specific codes', () => {
    const fastifyError = Object.assign(new Error('Unsupported Media Type: text/csv'), {
      statusCode: 415,
      code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
    });

    const mapped = toAppError(fastifyError);

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped).toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('turns anything else into a 500 without leaking its message', () => {
    const mapped = toAppError(new TypeError('Cannot read properties of undefined (reading "id")'));

    expect(mapped).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
  });
});
