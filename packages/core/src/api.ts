/**
 * The agent-facing API of a board.
 *
 * This is the one contract shared by every way of reaching a board: the server
 * implements it in-process, the SDK implements it over HTTP, and the MCP server
 * turns it into tools. Add a capability here first, then implement it.
 *
 * Two rules shape it:
 *  - Reads are budgeted. Every read takes `maxTokens`, reports the size of what
 *    it returned, and says when it left something out.
 *  - Reads return `text`, a compact rendering meant for a model, alongside the
 *    structured data meant for code.
 */
import { z } from 'zod';
import { type AppliedOps, OpBatchSchema, type OpError } from './ops.js';
import {
  type Actor,
  type Board,
  type BoardEdge,
  type BoardNode,
  type BoardSummary,
  IdSchema,
  NodeTypeSchema,
  StatusSchema,
} from './schema.js';

/**
 * Position in a board's change feed. It only ever grows. Pass the cursor from
 * your last read to `changes` to learn what happened since.
 */
export type Cursor = number;

export const DEFAULT_MAX_TOKENS = 2000;
export const MAX_MAX_TOKENS = 50_000;

const MaxTokensSchema = z.number().int().min(100).max(MAX_MAX_TOKENS).optional();

/** How much of each node a read returns. */
export const DetailSchema = z.enum(['titles', 'summary', 'full']);
export type Detail = z.infer<typeof DetailSchema>;

// ── Boards ───────────────────────────────────────────────────────────────────

export const CreateBoardInputSchema = z.object({
  /** Optional id; derived from the name when omitted. */
  id: IdSchema.optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateBoardInput = z.infer<typeof CreateBoardInputSchema>;

// ── Outline ──────────────────────────────────────────────────────────────────

export const OutlineOptionsSchema = z.object({ maxTokens: MaxTokensSchema });
export type OutlineOptions = z.infer<typeof OutlineOptionsSchema>;

export interface OutlineFrame {
  id: string;
  title: string;
  parent?: string;
  /** Direct children, by node type. */
  counts: Record<string, number>;
  /** Direct children that have a status, by status. */
  statuses: Record<string, number>;
}

/** The cheap first look at a board: its shape, not its content. */
export interface Outline {
  boardId: string;
  name: string;
  description?: string;
  cursor: Cursor;
  nodeCount: number;
  edgeCount: number;
  frames: OutlineFrame[];
  /** Counts for nodes that sit in no frame. */
  root: { counts: Record<string, number>; statuses: Record<string, number> };
  text: string;
  tokens: number;
  truncated: boolean;
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Selects nodes. Filters combine with AND. With no filter at all, a read covers
 * the whole board (subject to `maxTokens`).
 */
export const ReadQuerySchema = z.object({
  /** Exactly these nodes. */
  ids: z.array(IdSchema).max(200).optional(),
  /** Nodes inside this frame, at any depth. */
  frame: IdSchema.optional(),
  /** Only what the human has selected on the canvas right now. */
  selection: z.boolean().optional(),
  types: z.array(NodeTypeSchema).max(20).optional(),
  statuses: z.array(StatusSchema).max(5).optional(),
  /** Nodes carrying every one of these tags. */
  tags: z.array(z.string()).max(10).optional(),
  /** Case-insensitive match against title and body. */
  text: z.string().max(200).optional(),
  /** Also include nodes within this many edge hops of the matches. */
  neighbors: z.number().int().min(0).max(2).optional(),
  detail: DetailSchema.optional(),
  maxTokens: MaxTokensSchema,
});
export type ReadQuery = z.infer<typeof ReadQuerySchema>;

export interface ReadResult {
  boardId: string;
  cursor: Cursor;
  /** Nodes that fit the budget, trimmed to the requested detail. */
  nodes: BoardNode[];
  /** Edges with both ends in `nodes`. */
  edges: BoardEdge[];
  text: string;
  tokens: number;
  truncated: boolean;
  /** How many matching nodes were left out to stay within budget. */
  omitted: number;
}

// ── Changes ──────────────────────────────────────────────────────────────────

export const ChangeKindSchema = z.enum([
  'node_added',
  'node_updated',
  'node_removed',
  'node_moved',
  'edge_added',
  'edge_updated',
  'edge_removed',
]);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

export interface ChangeEntry {
  seq: Cursor;
  at: string;
  actor: string;
  kind: ChangeKind;
  /** Node or edge id. */
  id: string;
  /** For updates: which fields changed. */
  fields?: string[];
  /** Title of the node (or "source -> target" for an edge) at the time. */
  title?: string;
}

export const ChangesOptionsSchema = z.object({
  since: z.number().int().min(0),
  /** Include the caller's own changes. Off by default: you know what you did. */
  includeOwn: z.boolean().optional(),
  /** Include pure moves and resizes. Off by default: they are rarely meaningful. */
  includeMoves: z.boolean().optional(),
  maxTokens: MaxTokensSchema,
});
export type ChangesOptions = z.infer<typeof ChangesOptionsSchema>;

export interface ChangesResult {
  boardId: string;
  since: Cursor;
  cursor: Cursor;
  changes: ChangeEntry[];
  /**
   * True when `since` is older than the retained history. The caller should
   * re-read the board instead of trusting `changes` to be complete.
   */
  resync: boolean;
  text: string;
  tokens: number;
  truncated: boolean;
}

// ── Apply ────────────────────────────────────────────────────────────────────

export const ApplyRequestSchema = z.object({
  ops: OpBatchSchema,
  /** Validate and report, but change nothing. */
  dryRun: z.boolean().optional(),
  /** One line on why. Shown to humans next to the change. */
  reason: z.string().max(300).optional(),
  /**
   * `auto` (default) places new and unpinned nodes for you. `none` leaves
   * positions exactly as given.
   */
  layout: z.enum(['auto', 'none']).optional(),
});
export type ApplyRequest = z.infer<typeof ApplyRequestSchema>;

export interface ApplyResult {
  /**
   * `applied`  the batch is on the board.
   * `proposed` the batch is waiting for a human to accept it.
   * `valid`    dry run passed; nothing changed.
   * `invalid`  the batch was refused; see `errors`. Nothing changed.
   */
  status: 'applied' | 'proposed' | 'valid' | 'invalid';
  cursor: Cursor;
  /** Real ids for the `ref`s declared in the batch. */
  refs: Record<string, string>;
  applied?: AppliedOps;
  errors?: OpError[];
  proposalId?: string;
}

// ── Selection ────────────────────────────────────────────────────────────────

/** What a human is pointing at on the canvas right now. */
export interface SelectionResult {
  boardId: string;
  cursor: Cursor;
  /** Whose selection this is; null when nobody has anything selected. */
  by: Actor | null;
  nodeIds: string[];
  edgeIds: string[];
  nodes: BoardNode[];
  edges: BoardEdge[];
  text: string;
  tokens: number;
}

// ── Layout ───────────────────────────────────────────────────────────────────

export const LayoutRequestSchema = z.object({
  /**
   * `unpinned` (default) moves everything a human has not pinned. `all` also
   * moves pinned nodes and unpins them. A frame id lays out that frame only.
   */
  scope: z.union([z.enum(['unpinned', 'all']), IdSchema]).optional(),
  direction: z.enum(['down', 'right']).optional(),
});
export type LayoutRequest = z.infer<typeof LayoutRequestSchema>;

export interface LayoutResult {
  boardId: string;
  cursor: Cursor;
  moved: number;
}

// ── The API ──────────────────────────────────────────────────────────────────

/**
 * A session on a board server, bound to one actor. Everything a caller does
 * through it is attributed to that actor.
 */
export interface BoardApi {
  readonly actor: Actor;

  listBoards(): Promise<BoardSummary[]>;
  createBoard(input: CreateBoardInput): Promise<BoardSummary>;
  /** The whole board as JSON. Unbudgeted: meant for tools and exports, not for prompts. */
  getBoard(boardId: string): Promise<Board>;

  outline(boardId: string, options?: OutlineOptions): Promise<Outline>;
  read(boardId: string, query?: ReadQuery): Promise<ReadResult>;
  changes(boardId: string, options: ChangesOptions): Promise<ChangesResult>;
  apply(boardId: string, request: ApplyRequest): Promise<ApplyResult>;
  selection(boardId: string): Promise<SelectionResult>;
  layout(boardId: string, request?: LayoutRequest): Promise<LayoutResult>;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type OpenBoardErrorCode =
  | 'board_not_found'
  | 'board_exists'
  | 'invalid_request'
  | 'forbidden'
  | 'conflict'
  | 'unavailable'
  | 'internal';

/** The one error type that crosses package boundaries. */
export class OpenBoardError extends Error {
  readonly code: OpenBoardErrorCode;
  readonly details?: unknown;

  constructor(code: OpenBoardErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'OpenBoardError';
    this.code = code;
    this.details = details;
  }

  /** HTTP status the server uses for this error; the SDK maps it back. */
  get status(): number {
    switch (this.code) {
      case 'board_not_found':
        return 404;
      case 'board_exists':
      case 'conflict':
        return 409;
      case 'invalid_request':
        return 400;
      case 'forbidden':
        return 403;
      case 'unavailable':
        return 503;
      default:
        return 500;
    }
  }

  toJSON(): { error: { code: OpenBoardErrorCode; message: string; details?: unknown } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}
