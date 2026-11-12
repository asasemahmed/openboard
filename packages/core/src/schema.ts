/**
 * Board schema v1.
 *
 * A board is a typed graph. Nodes carry meaning (what something is), edges
 * carry relationships, and `view` carries presentation. Agents work on meaning;
 * presentation is filled in by the layout engine unless a human pinned it.
 */
import { z } from 'zod';
import type { AgentPresence, LiveSessions } from './live.js';

export const SCHEMA_VERSION = 1;

/** Limits that keep a single node from blowing an agent's context window. */
export const LIMITS = {
  title: 200,
  body: 20_000,
  label: 120,
  tag: 40,
  tagsPerNode: 20,
  linksPerNode: 50,
  opsPerBatch: 500,
} as const;

// ── Identifiers ──────────────────────────────────────────────────────────────

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export const IdSchema = z.string().regex(idPattern, 'invalid id');
export type NodeId = string;
export type EdgeId = string;
export type BoardId = string;
export type ActorId = string;

// ── Actors ───────────────────────────────────────────────────────────────────

export const ActorKindSchema = z.enum(['human', 'agent', 'system']);
export type ActorKind = z.infer<typeof ActorKindSchema>;

/**
 * A color as clients use it in CSS: `#rgb` to `#rrggbbaa`, a color name, or a
 * preset number. Nothing else, so a stored color can never be `url(...)` or
 * close a declaration.
 */
export const ColorSchema = z
  .string()
  .max(32)
  .regex(/^(#[0-9a-fA-F]{3,8}|[A-Za-z0-9]{1,32})$/, 'a color is #hex, a name or a number');

/** Anyone or anything that can change a board. */
export const ActorSchema = z.object({
  id: IdSchema,
  kind: ActorKindSchema,
  name: z.string().min(1).max(80),
  color: ColorSchema.optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

/** Used for changes that have no better owner (file reloads, migrations). */
export const SYSTEM_ACTOR: Actor = { id: 'system', kind: 'system', name: 'OpenBoard' };

// ── Node and edge vocabulary ─────────────────────────────────────────────────

export const BUILTIN_NODE_TYPES = [
  'note',
  'task',
  'decision',
  'question',
  'risk',
  'doc',
  'code',
  'agent',
  'run',
  'frame',
] as const;
export type BuiltinNodeType = (typeof BUILTIN_NODE_TYPES)[number];

export const BUILTIN_EDGE_TYPES = [
  'relates_to',
  'depends_on',
  'blocks',
  'implements',
  'evidence_for',
  'flows_to',
] as const;
export type BuiltinEdgeType = (typeof BUILTIN_EDGE_TYPES)[number];

/** Custom types are namespaced with `x:` so they can never collide with built-ins. */
const customTypePattern = /^x:[a-z][a-z0-9_-]{0,39}$/;

/** A custom node or edge type name, such as `x:persona`. */
export const CustomTypeSchema = z
  .string()
  .regex(
    customTypePattern,
    'custom types must look like "x:name" (lowercase, at most 40 characters)',
  );

export const NodeTypeSchema = z.union([
  z.enum(BUILTIN_NODE_TYPES),
  z.string().regex(customTypePattern, 'custom node types must look like "x:name"'),
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const EdgeTypeSchema = z.union([
  z.enum(BUILTIN_EDGE_TYPES),
  z.string().regex(customTypePattern, 'custom edge types must look like "x:name"'),
]);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

export const STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export const StatusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof StatusSchema>;

// ── JSON values (for free-form props) ────────────────────────────────────────

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);

// ── Links from a node to the outside world ───────────────────────────────────

export const LinkKindSchema = z.enum(['file', 'symbol', 'commit', 'pr', 'url']);
export type LinkKind = z.infer<typeof LinkKindSchema>;

export const LinkSchema = z.object({
  kind: LinkKindSchema,
  /** Repo-relative path, `path#symbol`, commit sha, PR reference, or URL. */
  target: z.string().min(1).max(500),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  /** Content hash of the target when the link was made; used to detect drift. */
  hash: z.string().max(80).optional(),
  /** Set by the server when the target changed or disappeared since `hash`. */
  stale: z.boolean().optional(),
});
export type Link = z.infer<typeof LinkSchema>;

// ── Presentation ─────────────────────────────────────────────────────────────

export const ViewSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive().optional(),
  h: z.number().finite().positive().optional(),
  /** A pinned node was placed by a human and is never moved by auto-layout. */
  pinned: z.boolean().optional(),
  color: ColorSchema.optional(),
  collapsed: z.boolean().optional(),
});
export type View = z.infer<typeof ViewSchema>;

// ── Nodes ────────────────────────────────────────────────────────────────────

const TimestampSchema = z.iso.datetime();

/** The fields an author controls. Everything else on a node is bookkeeping. */
export const NodeInputSchema = z.object({
  type: NodeTypeSchema,
  title: z.string().min(1).max(LIMITS.title),
  /** Markdown. */
  body: z.string().max(LIMITS.body).optional(),
  status: StatusSchema.optional(),
  /** Id of the frame this node sits in. */
  parent: IdSchema.optional(),
  tags: z.array(z.string().min(1).max(LIMITS.tag)).max(LIMITS.tagsPerNode).optional(),
  /** Type-specific data. Custom node types keep their fields here. */
  props: z.record(z.string(), JsonSchema).optional(),
  links: z.array(LinkSchema).max(LIMITS.linksPerNode).optional(),
  view: ViewSchema.optional(),
});
export type NodeInput = z.infer<typeof NodeInputSchema>;

export const NodeSchema = NodeInputSchema.extend({
  id: IdSchema,
  createdBy: IdSchema,
  createdAt: TimestampSchema,
  /** Last *semantic* change. Moving or resizing a node does not touch these. */
  updatedBy: IdSchema,
  updatedAt: TimestampSchema,
});
export type BoardNode = z.infer<typeof NodeSchema>;

// ── Edges ────────────────────────────────────────────────────────────────────

export const EdgeInputSchema = z.object({
  type: EdgeTypeSchema,
  source: IdSchema,
  target: IdSchema,
  label: z.string().max(LIMITS.label).optional(),
});
export type EdgeInput = z.infer<typeof EdgeInputSchema>;

export const EdgeSchema = EdgeInputSchema.extend({
  id: IdSchema,
  createdBy: IdSchema,
  createdAt: TimestampSchema,
  updatedBy: IdSchema,
  updatedAt: TimestampSchema,
});
export type BoardEdge = z.infer<typeof EdgeSchema>;

// ── Comments ─────────────────────────────────────────────────────────────────

/**
 * A comment in a thread. Defined here rather than in `collab.ts` because it is
 * part of the saved board; see `collab.ts` for how comments are used.
 */
export const CommentSchema = z.object({
  id: IdSchema,
  /** Id of the first comment of the thread; the first comment's `thread` is its own id. */
  thread: IdSchema,
  /**
   * The node the thread is attached to; replies carry the same value as the
   * first comment. A thread without one belongs to the board. When the node is
   * removed the comment keeps the id (so restoring the node re-attaches it) and
   * readers treat the thread as detached.
   */
  nodeId: IdSchema.optional(),
  author: IdSchema,
  /** Markdown. */
  body: z.string().min(1).max(4000),
  createdAt: z.iso.datetime(),
  /** Actor ids this comment addresses, or `MENTION_AGENTS` (`"agents"`). */
  mentions: z.array(z.string().max(64)).max(20).optional(),
  /** Set on the first comment of a thread when the thread is resolved. */
  resolvedAt: z.iso.datetime().optional(),
  resolvedBy: IdSchema.optional(),
});
export type Comment = z.infer<typeof CommentSchema>;

// ── Board ────────────────────────────────────────────────────────────────────

export const BoardMetaSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type BoardMeta = z.infer<typeof BoardMetaSchema>;

/**
 * The full, plain-JSON form of a board. This is what lives in
 * `.openboard/<id>.board.json` and what `BoardDoc.toJSON()` returns.
 */
export const BoardSchema = BoardMetaSchema.extend({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** People and agents that authored something on this board, by id. */
  actors: z.record(IdSchema, ActorSchema),
  nodes: z.record(IdSchema, NodeSchema),
  edges: z.record(IdSchema, EdgeSchema),
  /** Comment threads, by comment id. Absent when the board has none. */
  comments: z.record(IdSchema, CommentSchema).optional(),
});
export type Board = z.infer<typeof BoardSchema>;

export interface BoardSummary extends BoardMeta {
  nodeCount: number;
  edgeCount: number;
}

// ── Transactions ─────────────────────────────────────────────────────────────

/** Tag carried by every write to the board document. See docs/ARCHITECTURE.md. */
export interface TxOrigin {
  actorId: string;
  /** `code`: the server updating code links (hash, moved lines, `stale`); see code.ts. */
  source: 'ops' | 'ui' | 'layout' | 'file' | 'undo' | 'sync' | 'code';
}

/**
 * One awareness entry. Browsers publish their own (cursor, selection). The
 * server publishes one entry per agent and session with `agent` set, and one
 * entry with `actor` = `SYSTEM_ACTOR` carrying `live` (the session list).
 */
export interface Presence {
  actor: Actor;
  /** Pointer position in canvas coordinates. */
  cursor?: { x: number; y: number };
  selection?: { nodeIds: string[]; edgeIds: string[]; at: string };
  /** Set on entries the server publishes for agents. */
  agent?: AgentPresence;
  /** Set on the one entry the server publishes for the session list. */
  live?: LiveSessions;
}
