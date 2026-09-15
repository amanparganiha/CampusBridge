import { z } from 'zod';
import { BadRequestError } from './errors.js';
import { encodeCursor, type Page } from './pagination.js';

/**
 * Keyset pagination over a sort field plus the id as tie-breaker.
 *
 * `sort=title` or `sort=-createdAt` (leading minus = descending). The cursor records the sort it
 * was produced for, so replaying it with a different sort is rejected rather than silently
 * returning a wrong page. Only non-nullable columns are sortable (NULLs break keyset ordering).
 */

export interface SortOption<Field extends string = string> {
  field: Field;
  direction: 'asc' | 'desc';
}

export function sortQuerySchema<Field extends string>(
  fields: readonly Field[],
  defaultSort: string,
) {
  return z
    .string()
    .default(defaultSort)
    .transform((value, ctx): SortOption<Field> => {
      const direction = value.startsWith('-') ? 'desc' : 'asc';
      const field = value.replace(/^-/, '') as Field;
      if (!fields.includes(field)) {
        ctx.addIssue({
          code: 'custom',
          message: `sort must be one of: ${fields.join(', ')} (prefix - for descending)`,
        });
        return z.NEVER;
      }
      return { field, direction };
    });
}

const cursorSchema = z.object({
  s: z.string(),
  v: z.union([z.string(), z.number()]),
  id: z.uuid(),
});

const invalidCursor = () =>
  new BadRequestError('The pagination cursor is invalid or was made for a different sort.', {
    code: 'INVALID_CURSOR',
  });

const sortKey = (sort: SortOption) => `${sort.direction === 'desc' ? '-' : ''}${sort.field}`;

/** Prisma `where` and `orderBy` fragments for the page after `cursor`. */
export function keysetArgs(
  sort: SortOption,
  cursor: string | undefined,
  /** Converts a cursor value back to the column's type (e.g. ISO string -> Date). */
  parseValue: (field: string, value: string | number) => unknown = (_field, value) => value,
): { where: Record<string, unknown>; orderBy: Record<string, 'asc' | 'desc'>[] } {
  const orderBy =
    sort.field === 'id'
      ? [{ id: sort.direction }]
      : [{ [sort.field]: sort.direction }, { id: sort.direction }];
  if (!cursor) return { where: {}, orderBy };

  let position: z.infer<typeof cursorSchema>;
  try {
    position = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw invalidCursor();
  }
  if (position.s !== sortKey(sort)) throw invalidCursor();

  const after = sort.direction === 'asc' ? 'gt' : 'lt';
  if (sort.field === 'id') return { where: { id: { [after]: position.id } }, orderBy };
  const value = parseValue(sort.field, position.v);
  return {
    where: {
      OR: [
        { [sort.field]: { [after]: value } },
        { [sort.field]: value, id: { [after]: position.id } },
      ],
    },
    orderBy,
  };
}

/** Builds the page from `limit + 1` rows fetched with `keysetArgs`. */
export function keysetPage<Row extends { id: string }, Item>(
  rows: readonly Row[],
  limit: number,
  sort: SortOption,
  sortValue: (row: Row) => string | number,
  toItem: (row: Row) => Item,
): Page<Item> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    data: pageRows.map(toItem),
    pageInfo: {
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ s: sortKey(sort), v: sortValue(last), id: last.id })
          : null,
    },
  };
}
