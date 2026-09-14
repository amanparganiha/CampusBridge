import { z } from 'zod';
import { BadRequestError } from './errors.js';

/**
 * Cursor (keyset) pagination.
 *
 * Offset pagination degrades linearly with depth and skips or repeats rows when data changes
 * between requests. Keyset pagination seeks directly to the last row seen, so every page costs
 * the same. Cursors are opaque (base64url JSON): clients must not construct them, which keeps
 * the encoded position free to evolve without breaking the API contract.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(512).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Page<T> {
  data: T[];
  pageInfo: PageInfo;
}

export function pageSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    data: z.array(item),
    pageInfo: z.object({
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  });
}

export function encodeCursor(position: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

export function decodeCursor<Position>(cursor: string, schema: z.ZodType<Position>): Position {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = schema.safeParse(decoded);
  if (!result.success) throw invalidCursor();
  return result.data;
}

/**
 * Builds a page from rows fetched with `take: limit + 1`: the extra row only signals that
 * another page exists and is not returned.
 */
export function toPage<T>(
  rows: readonly T[],
  limit: number,
  positionOf: (row: T) => Record<string, unknown>,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : [...rows];
  const last = data.at(-1);
  return {
    data,
    pageInfo: {
      hasMore,
      nextCursor: hasMore && last !== undefined ? encodeCursor(positionOf(last)) : null,
    },
  };
}

function invalidCursor(): BadRequestError {
  return new BadRequestError('The pagination cursor is invalid or has expired.', {
    code: 'INVALID_CURSOR',
  });
}
