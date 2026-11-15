import { describe, expect, it } from 'vitest';
import {
  evaluateLink,
  findLinesOnce,
  linkPath,
  linkRangeLabel,
  linkRangeText,
  normaliseLineEndings,
} from './code.js';
import type { Link } from './schema.js';

// A stand-in for the server's SHA-256: the evaluation only compares hashes.
const hash = (text: string) => `h:${text}`;
const FILE = ['a', 'b', 'c', 'd'].join('\n');
const range: Link = { kind: 'file', target: 'src/x.ts', line: 2, endLine: 3, hash: 'h:b\nc' };

describe('code link helpers', () => {
  it('reads paths, ranges and line endings', () => {
    expect(linkPath({ kind: 'symbol', target: ' src/x.ts#foo ' })).toBe('src/x.ts');
    expect(linkPath({ kind: 'file', target: 'src/x.ts' })).toBe('src/x.ts');
    expect(normaliseLineEndings('a\r\nb\rc')).toBe('a\nb\nc');
    const lines = FILE.split('\n');
    expect(linkRangeText(lines, range)).toBe('b\nc');
    expect(linkRangeText(lines, { kind: 'file', target: 'x', line: 4, endLine: 5 })).toBeNull();
    expect(linkRangeText(lines, { kind: 'file', target: 'x' })).toBe(FILE);
    expect(linkRangeLabel(range)).toBe('lines 2-3');
    expect(linkRangeLabel({ kind: 'file', target: 'x', line: 2 })).toBe('line 2');
    expect(findLinesOnce(lines, ['b', 'c'])).toBe(2);
    expect(findLinesOnce(['a', 'a'], ['a'])).toBeNull();
  });
});

describe('evaluateLink', () => {
  it('says ok, stale or missing, and how the link should be stored', () => {
    expect(evaluateLink(range, FILE, { hash })).toEqual({
      state: 'ok',
      next: range,
      current: 'b\nc',
    });
    expect(evaluateLink({ ...range, stale: true }, FILE, { hash }).next).toEqual(range);
    expect(evaluateLink(range, 'a\nB\nc\nd', { hash })).toEqual({
      state: 'stale',
      detail: 'content changed at lines 2-3',
      next: { ...range, stale: true },
    });
    expect(evaluateLink(range, null, { hash })).toMatchObject({
      state: 'missing',
      detail: 'file missing',
    });
    expect(evaluateLink(range, undefined, { hash })).toMatchObject({ state: 'unchecked' });
    expect(evaluateLink({ kind: 'url', target: 'https://example.com' }, FILE, { hash })).toEqual({
      state: 'unchecked',
    });
  });

  it('hashes a link that has none only when asked', () => {
    const { hash: _h, ...unhashed } = range;
    expect(evaluateLink(unhashed, FILE, { hash })).toEqual({
      state: 'unchecked',
      detail: 'not hashed yet',
    });
    expect(evaluateLink(unhashed, FILE, { hash, fill: true }).next).toEqual(range);
    expect(
      evaluateLink({ ...unhashed, line: 9, endLine: 10 }, FILE, { hash, fill: true }),
    ).toMatchObject({
      state: 'stale',
      detail: 'lines 9-10 not in the file',
    });
  });

  it('follows moved code only when it knows the original text', () => {
    const moved = 'new\na\nb\nc\nd';
    expect(evaluateLink(range, moved, { hash }).state).toBe('stale');
    expect(evaluateLink(range, moved, { hash, original: 'b\nc' })).toEqual({
      state: 'ok',
      detail: 'moved to lines 3-4',
      next: { ...range, line: 3, endLine: 4 },
    });
  });
});
