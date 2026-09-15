/**
 * RFC 4180 CSV with protection against formula injection: a cell starting with = + - @ (or a tab
 * or carriage return) is executed by spreadsheet apps when the export is opened, so user-supplied
 * text like `=HYPERLINK(...)` in an audit log could attack whoever downloads it. Such cells are
 * prefixed with an apostrophe, which spreadsheets display but do not evaluate.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? value.toString()
          : JSON.stringify(value);
  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
