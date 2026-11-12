/**
 * Text helpers shared by the exporters and importers: escaping, plain-text
 * previews, words for types and statuses, and an approximate text measure for
 * places where no DOM is available.
 */
import { LIMITS, type Status } from '../schema.js';

/** Statuses as people say them. */
export const STATUS_WORDS: Record<Status, string> = {
  todo: 'to do',
  in_progress: 'in progress',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'cancelled',
};

const STATUS_BY_WORDS = new Map<string, Status>(
  Object.entries(STATUS_WORDS).flatMap(([status, words]) => [
    [words, status as Status],
    [status, status as Status],
  ]),
);

/** The status named by `words` ("in progress" or "in_progress"), if any. */
export function statusFromWords(words: string): Status | undefined {
  return STATUS_BY_WORDS.get(words.trim().toLowerCase());
}

/** A type as a short word: `depends_on` -> "depends on", `x:epic` -> "epic". */
export function typeWords(type: string): string {
  const bare = type.startsWith('x:') ? type.slice(2) : type;
  return bare.replace(/[_-]+/g, ' ');
}

/** Characters XML 1.0 does not allow at all, even escaped. */
const XML_INVALID = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]' +
    '|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  'g',
);

/** Escape text for XML content or a double-quoted attribute. */
export function xmlEscape(text: string): string {
  return text
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Collapse all whitespace, newlines included, to single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Markdown reduced to plain text on one line, for previews: code fences,
 * images, link targets, emphasis markers, heading and list markers and HTML
 * tags are removed.
 */
export function plainText(markdown: string): string {
  return oneLine(
    markdown
      .replace(/^\s*(```|~~~).*$/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, '')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/(^|\W)[*_](\S)/g, '$1$2')
      .replace(/(\S)[*_](\W|$)/g, '$1$2'),
  );
}

/** Cut text to `max` characters, ending with an ellipsis when it was cut. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`;
}

/** A title that fits the schema: one line, not empty, at most `LIMITS.title` characters. */
export function fitTitle(text: string, fallback = 'Untitled'): string {
  const line = oneLine(text);
  return clip(line || fallback, LIMITS.title);
}

/** A body that fits the schema, or undefined when there is nothing to keep. */
export function fitBody(text: string): string | undefined {
  const trimmed = text.replace(/^\s*\n/, '').trimEnd();
  if (!trimmed.trim()) return undefined;
  return clip(trimmed, LIMITS.body);
}

// ── Approximate text measure ─────────────────────────────────────────────────

/**
 * Advance widths in em for a proportional system sans-serif, grouped by
 * shape. Deliberately a little generous, so wrapped text errs on the early
 * side instead of overflowing its box.
 */
function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (char === ' ') return 0.28;
  if ("iljIt!|.,:;'`".includes(char)) return 0.3;
  if ('frJ()[]{}"/\\-'.includes(char)) return 0.38;
  if ('mwMW@'.includes(char)) return 0.86;
  if (code >= 0x41 && code <= 0x5a) return 0.66;
  if (code >= 0x30 && code <= 0x39) return 0.57;
  if (code >= 0x61 && code <= 0x7a) return 0.53;
  if (code < 0x80) return 0.6;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x20000
  ) {
    return 1.0;
  }
  return 0.62;
}

export interface FontSpec {
  size: number;
  /** Bold text is wider. */
  bold?: boolean;
  /** Monospace, with extra spacing between letters in px. */
  mono?: boolean;
  letterSpacing?: number;
}

/** Approximate rendered width of `text` in px. */
export function measureText(text: string, font: FontSpec): number {
  let em = 0;
  let count = 0;
  for (const char of text) {
    em += font.mono ? 0.62 : charWidth(char);
    count++;
  }
  const weight = font.bold && !font.mono ? 1.07 : 1;
  return em * font.size * weight + count * (font.letterSpacing ?? 0);
}

/**
 * `text` when it fits `width`, otherwise its longest prefix that fits with an
 * ellipsis after it. With `force`, the ellipsis is added even when it fits.
 */
export function truncateToWidth(
  text: string,
  width: number,
  font: FontSpec,
  force = false,
): string {
  if (!force && measureText(text, font) <= width) return text;
  const chars = Array.from(text);
  const ellipsis = measureText('…', font);
  let used = 0;
  let end = 0;
  for (; end < chars.length; end++) {
    const w = measureText(chars[end] as string, font);
    if (used + w + ellipsis > width) break;
    used += w;
  }
  return `${chars.slice(0, end).join('').trimEnd()}…`;
}

/**
 * Greedy word wrap into at most `maxLines` lines of `width` px. Words longer
 * than a line are broken between characters. When the text does not fit, the
 * last line ends with an ellipsis.
 */
export function wrapText(text: string, width: number, maxLines: number, font: FontSpec): string[] {
  const words = oneLine(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  const space = measureText(' ', font);
  let currentWidth = 0;
  let overflow = false;

  const push = (line: string) => {
    if (lines.length < maxLines) lines.push(line);
    else overflow = true;
  };

  for (const word of words) {
    const w = measureText(word, font);
    if (current && currentWidth + space + w <= width) {
      current += ` ${word}`;
      currentWidth += space + w;
      continue;
    }
    if (current) {
      push(current);
      current = '';
      currentWidth = 0;
    }
    if (w <= width) {
      current = word;
      currentWidth = w;
      continue;
    }
    // Break a word that is wider than a whole line.
    let piece = '';
    let pieceWidth = 0;
    for (const char of word) {
      const cw = measureText(char, font);
      if (piece && pieceWidth + cw > width) {
        push(piece);
        piece = '';
        pieceWidth = 0;
      }
      piece += char;
      pieceWidth += cw;
    }
    current = piece;
    currentWidth = pieceWidth;
  }
  if (current) push(current);
  if (overflow && lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = truncateToWidth(lines[last] as string, width, font, true);
  }
  return lines;
}
