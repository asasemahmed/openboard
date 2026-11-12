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
  /** An exporter name (see `EXPORTERS`): `json`, `markdown`, `mermaid`, `jsoncanvas`, `svg`. */
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
