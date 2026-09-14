import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  problemType,
  toProblem,
} from '../../../src/lib/errors.js';

describe('problemType', () => {
  it('derives a stable URN from the error code', () => {
    expect(problemType('SECTION_FULL')).toBe('urn:campusbridge:problem:section-full');
  });
});

describe('toProblem', () => {
  it('renders an RFC 9457 document with request correlation', () => {
    const problem = toProblem(new NotFoundError('Course not found.'), {
      requestId: 'req-123',
      instance: '/api/v1/courses/42',
    });

    expect(problem).toEqual({
      type: 'urn:campusbridge:problem:not-found',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Course not found.',
      instance: '/api/v1/courses/42',
      requestId: 'req-123',
    });
  });

  it('lets a subclass carry a more specific code', () => {
    const problem = toProblem(new ConflictError('Section is full.', { code: 'SECTION_FULL' }));

    expect(problem).toMatchObject({ status: 409, code: 'SECTION_FULL', title: 'Conflict' });
  });

  it('includes field errors for validation failures', () => {
    const problem = toProblem(
      new ValidationError([{ path: 'body.email', message: 'Invalid email' }]),
    );

    expect(problem.errors).toEqual([{ path: 'body.email', message: 'Invalid email' }]);
    expect(problem.code).toBe('VALIDATION_FAILED');
  });

  it('never exposes internal messages for server errors', () => {
    const problem = toProblem(
      new InternalServerError({ cause: new Error('connection to db-7 refused') }),
    );

    expect(problem.detail).toBe('An unexpected error occurred.');
    expect(JSON.stringify(problem)).not.toContain('db-7');
  });
});

describe('UnauthorizedError', () => {
  it('advertises the bearer scheme', () => {
    expect(new UnauthorizedError().headers).toEqual({ 'www-authenticate': 'Bearer' });
  });
});
