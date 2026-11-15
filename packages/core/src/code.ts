/**
 * Boards that know about the code and the git history around them: links from
 * nodes to source files that notice when that code changes, the board file's
 * git revisions and diffs between them, and import and export through the
 * formats in `interop/`.
 *
 * Link upkeep is done by the server. It writes `hash`, `line`/`endLine` (when
 * code moved) and `stale` on `file` and `symbol` links as the system actor with
 * the transaction source `code`: such writes show in the change feed, keep the
 * node's bookkeeping fields, never need review, and are not history batches.
 */
import { z } from 'zod';
import type { ApplyResult, Cursor } from './api.js';
import type { BoardDiff } from './diff.js';
import { IdSchema, type Link } from './schema.js';

// ── Code links ───────────────────────────────────────────────────────────────

/**
 * Prefix of the content hashes the server stores in `Link.hash`: SHA-256 of
 * the UTF-8 text with line endings normalised to `\n`, hex, cut to the first
 * 32 characters (128 bits). For a link with `line` the text is lines
 * `line..endLine` (1-based, inclusive; `endLine` defaults to `line`) joined
 * with `\n`; otherwise the whole file.
 */
export const LINK_HASH_PREFIX = 'sha256:';

/** Ranges longer than this are not relocated when their code moves; they turn stale instead. */
export const RELOCATE_MAX_LINES = 200;

/**
 * `ok`        the linked code is as it was when hashed.
 * `stale`     it changed since (or the node says so: `stale: true`).
 * `missing`   the file is gone.
 * `outside`   the target is not a path inside the project; it is never read.
 * `unchecked` not a code link (`commit`, `pr`, `url`), or not hashed yet.
 */
export const LinkStateSchema = z.enum(['ok', 'stale', 'missing', 'outside', 'unchecked']);
export type LinkState = z.infer<typeof LinkStateSchema>;

export const LinksOptionsSchema = z.object({
  /** Only links that are not `ok` or `unchecked`. */
  stale: z.boolean().optional(),
  maxTokens: z.number().int().min(100).max(50_000).optional(),
});
export type LinksOptions = z.infer<typeof LinksOptionsSchema>;

export interface LinkEntry {
  nodeId: string;
  /** The node's title (board content). */
  title: string;
  /** Position in the node's `links`. */
  index: number;
  link: Link;
  state: LinkState;
  /** What changed, e.g. `file missing` or `content changed at lines 10-14`. */
  detail?: string;
}

export interface LinksResult {
  boardId: string;
  cursor: Cursor;
  /** By node (board order), then link index. */
  links: LinkEntry[];
  text: string;
  tokens: number;
  truncated: boolean;
}

/** Which nodes' links to re-hash against the code as it is now. Give `nodeIds`, or `all: true`. */
export const RefreshLinksRequestSchema = z
  .object({
    nodeIds: z.array(IdSchema).min(1).max(200).optional(),
    all: z.boolean().optional(),
  })
  .refine((r) => (r.nodeIds !== undefined) !== (r.all === true), {
    message: 'give nodeIds, or all: true',
  });
export type RefreshLinksRequest = z.infer<typeof RefreshLinksRequestSchema>;

/** Whether a link points into the project's code (`file` or `symbol`). */
export function isCodeLink(link: Link): boolean {
  return link.kind === 'file' || link.kind === 'symbol';
}

/** The path part of a code link's target (`symbol` targets are `path#name`), trimmed. */
export function linkPath(link: Link): string {
  return (link.kind === 'symbol' ? (link.target.split('#')[0] ?? '') : link.target).trim();
}

/** Text with `\r\n` and `\r` line endings turned into `\n`, as it is hashed. */
export function normaliseLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** The text of a link's range in a file's lines, or null when the range is not in the file. */
export function linkRangeText(lines: string[], link: Link): string | null {
  if (link.line === undefined) return lines.join('\n');
  const end = link.endLine ?? link.line;
  if (link.line < 1 || end < link.line || end > lines.length) return null;
  return lines.slice(link.line - 1, end).join('\n');
}

/** `line 4`, `lines 4-9`, or `` for a whole-file link. */
export function linkRangeLabel(link: Link): string {
  if (link.line === undefined) return '';
  const end = link.endLine ?? link.line;
  return end === link.line ? `line ${link.line}` : `lines ${link.line}-${end}`;
}

/** The 1-based line where `needle` starts in `lines`, when it occurs exactly once. */
export function findLinesOnce(lines: string[], needle: string[]): number | null {
  if (needle.length === 0 || needle.length > lines.length) return null;
  let found: number | null = null;
  outer: for (let i = 0; i + needle.length <= lines.length; i++) {
    for (let j = 0; j < needle.length; j++) if (lines[i + j] !== needle[j]) continue outer;
    if (found !== null) return null;
    found = i + 1;
  }
  return found;
}

/** What the linked code says about a code link. */
export interface LinkEvaluation {
  state: LinkState;
  detail?: string;
  /** The link as it should be stored, when that may differ. */
  next?: Link;
  /** The linked text as it is now, when it matches the link's hash (or was just hashed). */
  current?: string;
}

export interface EvaluateLinkOptions {
  /** The content hash of a text, as `Link.hash` holds it (see `LINK_HASH_PREFIX`). */
  hash: (text: string) => string;
  /** Fill `hash` on a link that has none; otherwise such a link is `unchecked`. */
  fill?: boolean;
  /** The text the link's range had when it was hashed, when known: code that moved is followed. */
  original?: string;
}

/**
 * The state of a `file` or `symbol` link against the linked file's text
 * (with normalised line endings), `null` when the file is missing, or
 * `undefined` when it was too large to read. Resolving the path and reading
 * the file is the caller's job; this is the rest of the code link upkeep,
 * the same for the server and for checks run without one.
 *
 * When the text changed and `original` sits exactly once elsewhere in the
 * file, the range moved: the state is `ok` and `next` has the new lines.
 * The stored `stale` mark is not read: `next` sets or clears it.
 */
export function evaluateLink(
  link: Link,
  file: string | null | undefined,
  options: EvaluateLinkOptions,
): LinkEvaluation {
  if (!isCodeLink(link)) return { state: 'unchecked' };
  if (file === undefined) return { state: 'unchecked', detail: 'file too large to check' };
  const withStale = (stale: boolean): Link => {
    const { stale: _s, ...rest } = link;
    return stale ? { ...rest, stale: true } : rest;
  };
  if (file === null) return { state: 'missing', detail: 'file missing', next: withStale(true) };
  const lines = file.split('\n');
  const current = linkRangeText(lines, link);
  if (link.hash === undefined) {
    if (!options.fill) return { state: 'unchecked', detail: 'not hashed yet' };
    if (current === null) {
      return {
        state: 'stale',
        detail: `${linkRangeLabel(link)} not in the file`,
        next: withStale(true),
      };
    }
    return { state: 'ok', next: { ...withStale(false), hash: options.hash(current) }, current };
  }
  if (current !== null && options.hash(current) === link.hash) {
    return { state: 'ok', next: withStale(false), current };
  }
  // Changed. If the original text of a range sits exactly once elsewhere, the code moved.
  const original = link.line !== undefined ? options.original : undefined;
  if (original !== undefined) {
    const needle = original.split('\n');
    const found = findLinesOnce(lines, needle);
    if (found !== null) {
      const moved: Link = { ...withStale(false), line: found };
      if (link.endLine !== undefined || needle.length > 1)
        moved.endLine = found + needle.length - 1;
      else delete moved.endLine;
      return { state: 'ok', detail: `moved to ${linkRangeLabel(moved)}`, next: moved };
    }
  }
  const where = link.line !== undefined ? ` at ${linkRangeLabel(link)}` : '';
  return { state: 'stale', detail: `content changed${where}`, next: withStale(true) };
}

// ── Git ──────────────────────────────────────────────────────────────────────

/**
 * A git revision as the API accepts it: a commit id, branch, tag, or
 * `HEAD~2`-style expression. Conservative on purpose: no leading `-`, no
 * whitespace, no `:` and no `..` ranges.
 */
export const RevisionSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/, 'invalid revision')
  .refine((rev) => !rev.includes('..') && !rev.endsWith('.lock') && !rev.includes('@{-'), {
    message: 'invalid revision',
  });

export const RevisionsOptionsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});
export type RevisionsOptions = z.infer<typeof RevisionsOptionsSchema>;

export interface Revision {
  /** Full commit id. */
  rev: string;
  short: string;
  /** Author date, ISO 8601. */
  at: string;
  author: string;
  subject: string;
}

export interface RevisionsResult {
  boardId: string;
  /** False when the project is not a git repository, git is missing, or the board file is not tracked. */
  tracked: boolean;
  /** Newest first. */
  revisions: Revision[];
  /** The board file on disk differs from the last commit. */
  dirty: boolean;
  text: string;
}

export const DiffRequestSchema = z.object({
  from: RevisionSchema,
  /** Omit to compare with the live board. */
  to: RevisionSchema.optional(),
});
export type DiffRequest = z.infer<typeof DiffRequestSchema>;

export interface DiffResult {
  boardId: string;
  from: string;
  /** The revision compared to, or `live`. */
  to: string;
  diff: BoardDiff;
  text: string;
  tokens: number;
  truncated: boolean;
}

// ── Import and export ────────────────────────────────────────────────────────

export const ImportRequestSchema = z.object({
  /** An importer name (see `IMPORTERS`); detected from `filename` and `text` when omitted. */
  format: z.string().max(40).optional(),
  text: z.string().min(1).max(1_500_000),
  filename: z.string().max(255).optional(),
  /** Put every imported top-level node inside this frame. */
  frame: IdSchema.optional(),
  dryRun: z.boolean().optional(),
});
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export type ImportIntoResult = ApplyResult & {
  /** The format that was read. */
  format: string;
  /** Things the importer skipped or changed, one sentence each. */
  warnings: string[];
};

export const ExportOptionsSchema = z.object({
  /** An exporter name (see `EXPORTERS`): `json`, `markdown`, `mermaid`, `jsoncanvas`, `svg`, `html`. */
  format: z.string().max(40),
  theme: z.enum(['light', 'dark']).optional(),
  /** `svg` only: draw the changes since this revision. */
  diffFrom: RevisionSchema.optional(),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

export interface ExportResult {
  text: string;
  mime: string;
  /** A name for the downloaded file, e.g. `plan.svg` or `plan.diff.svg`. */
  filename: string;
}
