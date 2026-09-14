import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BadRequestError } from '../../../src/lib/errors.js';
import {
  decodeCursor,
  encodeCursor,
  MAX_PAGE_SIZE,
  paginationQuerySchema,
  toPage,
} from '../../../src/lib/pagination.js';

const positionSchema = z.object({ id: z.uuid() });
const rows = Array.from({ length: 5 }, (_, index) => ({
  id: `0190c7a0-0000-7000-8000-00000000000${String(index)}`,
}));

describe('cursor codec', () => {
  it('round-trips a position', () => {
    const position = { id: rows[0]!.id };

    expect(decodeCursor(encodeCursor(position), positionSchema)).toEqual(position);
  });

  it.each([
    ['not base64 json', 'this is not a cursor'],
    ['valid json, wrong shape', encodeCursor({ id: 'not-a-uuid' })],
    ['valid json, missing key', encodeCursor({ other: 1 })],
  ])('rejects a %s cursor as a client error', (_label, cursor) => {
    expect(() => decodeCursor(cursor, positionSchema)).toThrow(BadRequestError);
    try {
      decodeCursor(cursor, positionSchema);
    } catch (error) {
      expect((error as BadRequestError).code).toBe('INVALID_CURSOR');
    }
  });
});

describe('toPage', () => {
  it('returns limit rows and a cursor to the last one when more exist', () => {
    const page = toPage(rows, 3, (row) => ({ id: row.id }));

    expect(page.data).toHaveLength(3);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(decodeCursor(page.pageInfo.nextCursor!, positionSchema)).toEqual({ id: rows[2]!.id });
  });

  it('signals the final page with a null cursor', () => {
    const page = toPage(rows.slice(0, 2), 3, (row) => ({ id: row.id }));

    expect(page).toEqual({
      data: rows.slice(0, 2),
      pageInfo: { hasMore: false, nextCursor: null },
    });
  });
});

describe('paginationQuerySchema', () => {
  it('defaults and coerces the limit from a query string', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(paginationQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
  });

  it('caps the page size', () => {
    expect(paginationQuerySchema.safeParse({ limit: String(MAX_PAGE_SIZE + 1) }).success).toBe(
      false,
    );
  });
});
