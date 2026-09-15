import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../../../src/lib/errors.js';
import {
  keysetArgs,
  keysetPage,
  sortQuerySchema,
  type SortOption,
} from '../../../src/lib/keyset.js';
import { encodeCursor } from '../../../src/lib/pagination.js';

const FIELDS = ['title', 'createdAt'] as const;
const schema = sortQuerySchema(FIELDS, 'title');
const id = (n: number) => `0190c7a0-0000-7000-8000-00000000000${String(n)}`;

describe('sortQuerySchema', () => {
  it('parses ascending and descending sorts, with a default', () => {
    expect(schema.parse(undefined)).toEqual({ field: 'title', direction: 'asc' });
    expect(schema.parse('-createdAt')).toEqual({ field: 'createdAt', direction: 'desc' });
  });

  it('rejects fields that are not sortable', () => {
    const result = schema.safeParse('passwordHash');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('title, createdAt');
  });
});

describe('keysetArgs', () => {
  const byTitle: SortOption = { field: 'title', direction: 'asc' };

  it('orders by the field with the id as a tie-breaker', () => {
    expect(keysetArgs(byTitle, undefined)).toEqual({
      where: {},
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
    });
  });

  it('seeks past the cursor position, including ties on the sort value', () => {
    const cursor = encodeCursor({ s: '-createdAt', v: '2026-09-01T00:00:00.000Z', id: id(3) });
    const args = keysetArgs(
      { field: 'createdAt', direction: 'desc' },
      cursor,
      (_field, value) => new Date(String(value)),
    );

    const at = new Date('2026-09-01T00:00:00.000Z');
    expect(args.where).toEqual({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id(3) } }],
    });
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it.each([
    ['garbage', 'not a cursor'],
    ['a cursor for another sort', encodeCursor({ s: '-title', v: 'Biology', id: id(1) })],
    ['a malformed position', encodeCursor({ s: 'title', v: 'Biology', id: 'nope' })],
  ])('rejects %s', (_label, cursor) => {
    expect(() => keysetArgs(byTitle, cursor)).toThrow(BadRequestError);
  });
});

describe('keysetPage', () => {
  const rows = [1, 2, 3].map((n) => ({ id: id(n), title: `Course ${String(n)}` }));
  const sort: SortOption = { field: 'title', direction: 'asc' };

  it('returns limit rows and a cursor that resumes after the last one', () => {
    const page = keysetPage(
      rows,
      2,
      sort,
      (row) => row.title,
      (row) => row.title,
    );

    expect(page.data).toEqual(['Course 1', 'Course 2']);
    expect(page.pageInfo.hasMore).toBe(true);
    const next = keysetArgs(sort, page.pageInfo.nextCursor ?? undefined);
    expect(next.where).toEqual({
      OR: [{ title: { gt: 'Course 2' } }, { title: 'Course 2', id: { gt: id(2) } }],
    });
  });

  it('ends with a null cursor', () => {
    expect(
      keysetPage(
        rows,
        3,
        sort,
        (row) => row.title,
        (row) => row.id,
      ).pageInfo,
    ).toEqual({
      hasMore: false,
      nextCursor: null,
    });
  });
});
