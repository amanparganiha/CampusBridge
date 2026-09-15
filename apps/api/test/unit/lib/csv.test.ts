import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/lib/crypto/hash.js';
import { csvCell, csvRow } from '../../../src/lib/csv.js';

describe('csvCell', () => {
  it.each([
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1-555-0100', "'+1-555-0100"],
    ['-2', "'-2"],
    ['@import', "'@import"],
    ['\tindent', "'\tindent"],
  ])('neutralises the formula trigger in %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('quotes cells containing separators, quotes or line breaks (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
  });

  it('formats dates, numbers, empties and JSON', () => {
    expect(csvCell(new Date('2026-09-15T10:00:00Z'))).toBe('2026-09-15T10:00:00.000Z');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('ends rows with CRLF', () => {
    expect(csvRow(['a', 1, null])).toBe('a,1,\r\n');
  });
});

describe('canonicalJson', () => {
  it('is independent of key order, at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, { e: 0, f: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('keeps array order and treats a missing body as null', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson(undefined)).toBe('null');
  });
});
