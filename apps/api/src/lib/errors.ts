import { STATUS_CODES } from 'node:http';

/**
 * Application errors and their RFC 9457 "Problem Details" representation.
 *
 * Every error response is `application/problem+json` carrying a stable, machine-readable
 * `code` that clients branch on (titles and details are for humans and may change), plus the
 * request id so a support ticket can be matched to logs and traces.
 */

export interface FieldError {
  /** Location of the offending value, e.g. `body.email` or `querystring.limit`. */
  path: string;
  message: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: FieldError[];
}

export interface AppErrorOptions {
  /** Overrides the class's default code, e.g. `SECTION_FULL` instead of `CONFLICT`. */
  code?: string;
  cause?: unknown;
  errors?: FieldError[];
  /** Response headers that belong with this error (e.g. Retry-After, WWW-Authenticate). */
  headers?: Record<string, string>;
}

const PROBLEM_TYPE_PREFIX = 'urn:campusbridge:problem:';

/** `SECTION_FULL` -> `urn:campusbridge:problem:section-full` */
export function problemType(code: string): string {
  return PROBLEM_TYPE_PREFIX + code.toLowerCase().replaceAll('_', '-');
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly errors: FieldError[] | undefined;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, detail?: string, options: AppErrorOptions = {}) {
    super(detail ?? STATUS_CODES[status] ?? 'Error', { cause: options.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = options.code ?? code;
    this.title = STATUS_CODES[status] ?? 'Error';
    this.errors = options.errors;
    this.headers = options.headers ?? {};
  }

  /** True when `detail` was provided, i.e. the message is meant for API clients. */
  get hasDetail(): boolean {
    return this.message !== this.title;
  }
}

export class BadRequestError extends AppError {
  constructor(detail?: string, options?: AppErrorOptions) {
    super(400, 'BAD_REQUEST', detail, options);
  }
}

export class ValidationError extends AppError {
  constructor(errors: FieldError[], detail = 'The request contains invalid values.') {
    super(400, 'VALIDATION_FAILED', detail, { errors });
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail = 'Authentication is required.', options?: AppErrorOptions) {
    super(401, 'UNAUTHENTICATED', detail, {
      ...options,
      headers: { 'www-authenticate': 'Bearer', ...options?.headers },
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(
    detail = 'You do not have permission to perform this action.',
    options?: AppErrorOptions,
  ) {
    super(403, 'FORBIDDEN', detail, options);
  }
}

export class NotFoundError extends AppError {
  constructor(detail = 'The requested resource was not found.', options?: AppErrorOptions) {
    super(404, 'NOT_FOUND', detail, options);
  }
}

export class ConflictError extends AppError {
  constructor(
    detail = 'The request conflicts with the current state of the resource.',
    options?: AppErrorOptions,
  ) {
    super(409, 'CONFLICT', detail, options);
  }
}

export class UnprocessableError extends AppError {
  constructor(detail: string, options?: AppErrorOptions) {
    super(422, 'UNPROCESSABLE', detail, options);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(detail = 'Too many requests. Please retry later.', options?: AppErrorOptions) {
    super(429, 'RATE_LIMITED', detail, options);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(detail = 'The service is temporarily unavailable.', options?: AppErrorOptions) {
    super(503, 'SERVICE_UNAVAILABLE', detail, options);
  }
}

export class InternalServerError extends AppError {
  constructor(options?: AppErrorOptions) {
    // Never echo internal messages to clients; the cause is logged server-side.
    super(500, 'INTERNAL_ERROR', 'An unexpected error occurred.', options);
  }
}

export function toProblem(
  error: AppError,
  context: { requestId?: string; instance?: string } = {},
): ProblemDetails {
  return {
    type: problemType(error.code),
    title: error.title,
    status: error.status,
    code: error.code,
    ...(error.hasDetail ? { detail: error.message } : {}),
    ...(context.instance ? { instance: context.instance } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(error.errors ? { errors: error.errors } : {}),
  };
}
