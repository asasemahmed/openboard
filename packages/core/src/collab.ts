/**
 * Collaboration between people and agents: who may change what without asking,
 * proposals that wait for a decision, the history that makes changes undoable,
 * comments, and questions an agent puts to a human.
 *
 * Everything here is plain JSON. Proposals, questions, and comments live in the
 * board document next to nodes and edges (top-level maps `proposals`, `asks`,
 * `comments`), so every browser sees them live. Comments are also saved in the
 * board file; proposals and questions are working state and are not.
 */
import { z } from 'zod';
import { OpSchema } from './ops.js';
import { CommentSchema, EdgeSchema, IdSchema, NodeSchema, ViewSchema } from './schema.js';
import { EdgeTypesSchema, NodeTypesSchema } from './typedefs.js';

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * How much an agent may change without a human accepting it first.
 *
 * `auto`               every change applies directly.
 * `review_destructive` adding is free; so is changing or removing what the same
 *                      agent created and nobody else has touched. Changing or
 *                      removing anything else, or moving a pinned node, waits
 *                      for review. This is the default.
 * `review_all`         every change waits for review.
 * `locked`             the agent may read but not change anything.
 *
 * People are never restricted. The rules in detail (implemented by
 * `classifyOps`):
 *
 * - An agent in `locked` mode is refused everything; frame overrides do not
 *   lift that.
 * - Otherwise the nearest enclosing frame that sets `FRAME_POLICY_PROP` wins
 *   (for a frame itself, its own setting counts). `locked` refuses, `review`
 *   waits for review, `auto` frees. Frames that existed before the batch are
 *   judged by their setting before the batch, so a batch cannot loosen its own
 *   rules.
 * - Under `review_destructive`, moving a node that is not pinned is free.
 * - Operations on nodes and edges created earlier in the same batch count as
 *   adding.
 * - An edge is judged at both of its ends; the stricter verdict wins.
 * - Moving a node into or out of a `locked` frame is refused, into or out of a
 *   `review` frame waits for review. Removing a node also judges what goes
 *   with it: a frame's children (removed or lifted out) and the edges that
 *   touch it.
 */
export const PolicyModeSchema = z.enum(['auto', 'review_destructive', 'review_all', 'locked']);
export type PolicyMode = z.infer<typeof PolicyModeSchema>;

/**
 * A frame can override the mode for everything inside it, through this key in
 * its `props`. The nearest enclosing frame that sets it wins.
 * `auto` frees a workspace for agents, `review` protects an area, `locked`
 * makes it read-only for agents.
 */
export const FRAME_POLICY_PROP = 'openboard.policy';
export const FramePolicySchema = z.enum(['auto', 'review', 'locked']);
export type FramePolicy = z.infer<typeof FramePolicySchema>;

/** Project-wide settings, stored in `.openboard/config.json` and meant to be committed. */
export const ProjectConfigSchema = z.object({
  version: z.literal(1),
  policy: z.object({
    /** Mode for agents that have no entry of their own. */
    default: PolicyModeSchema,
    /** Mode per agent, by actor id. */
    agents: z.record(IdSchema, PolicyModeSchema),
  }),
  /** Declared node types, by `x:` name (see typedefs.ts). */
  nodeTypes: NodeTypesSchema.optional(),
  /** Declared edge types, by `x:` name. */
  edgeTypes: EdgeTypesSchema.optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const DEFAULT_CONFIG: ProjectConfig = {
  version: 1,
  policy: { default: 'review_destructive', agents: {} },
};

/** What the policy says about one operation in an agent's batch. */
export type OpVerdict = 'free' | 'review' | 'denied';

// ── Proposals ────────────────────────────────────────────────────────────────

export const ProposalItemStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'conflict']);

/** One operation of a proposed batch, decided on its own. */
export const ProposalItemSchema = z.object({
  /** Position in the original batch. */
  index: z.number().int().min(0),
  /** The operation with every `$ref` already replaced by the id it will get. */
  op: OpSchema,
  status: ProposalItemStatusSchema,
  /** False for operations that were free on their own but travel with ones that need review. */
  needsReview: z.boolean(),
  /** Items that must be accepted for this one to make sense (e.g. the node an edge attaches to). */
  dependsOn: z.array(z.number().int().min(0)),
  /** One line a person can read, e.g. `Update "Payment API": status in_progress → done`. */
  summary: z.string(),
  /**
   * Why the item cannot be applied, when `status` is `conflict`: its target was
   * changed or removed after it was proposed (detected while the proposal is
   * pending), or it failed validation when it was accepted.
   */
  conflict: z.string().optional(),
  /**
   * A fingerprint (`itemFingerprint`) of each existing node or edge the item
   * changes or removes, as it was when proposed. A different value later means
   * someone changed it in the meantime (moving it does not count), and the item
   * becomes a conflict instead of overwriting that change.
   */
  base: z.record(IdSchema, z.string()).optional(),
});
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

export const ProposalStatusSchema = z.enum([
  'pending',
  'accepted',
  'partly_accepted',
  'rejected',
  'withdrawn',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** What the board would look like, so the canvas can draw the proposal as ghosts. */
export const ProposalPreviewSchema = z.object({
  /** Nodes the proposal adds, complete with a view chosen by the layout engine. */
  nodes: z.record(IdSchema, NodeSchema),
  edges: z.record(IdSchema, EdgeSchema),
  /** Existing nodes and edges it changes, with the fields that would change. */
  updated: z.record(IdSchema, z.object({ fields: z.array(z.string()) })),
  removedNodes: z.array(IdSchema),
  removedEdges: z.array(IdSchema),
  /**
   * New views of existing nodes that the layout would change if the proposal
   * were accepted: frames that grow to hold what is added (keeping their
   * position), unpinned siblings they push aside, and nodes moved to another
   * frame. Complete views, relative to the parent as usual. Absent when
   * nothing would move.
   */
  views: z.record(IdSchema, ViewSchema).optional(),
});
export type ProposalPreview = z.infer<typeof ProposalPreviewSchema>;

export const ProposalSchema = z.object({
  id: IdSchema,
  author: IdSchema,
  reason: z.string().max(300).optional(),
  createdAt: z.iso.datetime(),
  status: ProposalStatusSchema,
  items: z.array(ProposalItemSchema),
  preview: ProposalPreviewSchema,
  decidedBy: IdSchema.optional(),
  decidedAt: z.iso.datetime().optional(),
  /** What the reviewer said. Reaches the author through its inbox. */
  note: z.string().max(1000).optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const DecisionSchema = z.object({
  action: z.enum(['accept', 'reject']),
  /** Item indexes to decide. Omit to decide everything still pending. */
  items: z.array(z.number().int().min(0)).optional(),
  note: z.string().max(1000).optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

// ── Comments ─────────────────────────────────────────────────────────────────

/** Mention this instead of an actor id to address every agent on the board. */
export const MENTION_AGENTS = 'agents';

// `CommentSchema` and `Comment` live in schema.ts, because comments are part of
// the saved board. They are exported from the package entry point as usual.

export const CommentInputSchema = z.object({
  body: CommentSchema.shape.body,
  /** Reply in this thread. Omit to start a new thread. */
  thread: IdSchema.optional(),
  /** Attach a new thread to this node. Ignored when `thread` is given. */
  nodeId: IdSchema.optional(),
  mentions: CommentSchema.shape.mentions,
});
export type CommentInput = z.infer<typeof CommentInputSchema>;

// ── Questions an agent asks a human ──────────────────────────────────────────

export const AskSchema = z.object({
  id: IdSchema,
  author: IdSchema,
  /** `approval` is a yes/no gate before the agent does something; `question` is anything else. */
  kind: z.enum(['question', 'approval']),
  question: z.string().min(1).max(1000),
  /** Suggested answers. The human may still answer in free text. */
  options: z.array(z.string().min(1).max(120)).max(6).optional(),
  /** Nodes the question is about; the canvas points at them. */
  nodeIds: z.array(IdSchema).max(20).optional(),
  status: z.enum(['open', 'answered', 'cancelled']),
  createdAt: z.iso.datetime(),
  answer: z
    .object({
      by: IdSchema,
      at: z.iso.datetime(),
      /** The chosen option, when one was chosen. */
      option: z.string().optional(),
      text: z.string().max(2000).optional(),
    })
    .optional(),
});
export type Ask = z.infer<typeof AskSchema>;

export const AskInputSchema = z.object({
  kind: AskSchema.shape.kind.optional(),
  question: AskSchema.shape.question,
  options: AskSchema.shape.options,
  nodeIds: AskSchema.shape.nodeIds,
});
export type AskInput = z.infer<typeof AskInputSchema>;

export const AnswerInputSchema = z
  .object({ option: z.string().optional(), text: z.string().max(2000).optional() })
  .refine((answer) => answer.option !== undefined || answer.text !== undefined, {
    message: 'give an option, a text, or both',
  });
export type AnswerInput = z.infer<typeof AnswerInputSchema>;

/** Longest a single call may wait for an answer before returning the still-open question. */
export const MAX_ASK_WAIT_MS = 300_000;

// ── History and undo ─────────────────────────────────────────────────────────

/**
 * One applied change: an agent's batch, an accepted proposal, a layout run, a
 * file reload, or a short burst of edits by one person in the browser.
 */
export interface Batch {
  id: string;
  /** The board cursor right after this batch. */
  cursor: number;
  at: string;
  actor: string;
  /**
   * `ops` an agent's batch, an accepted proposal, or a comment made through the
   * API; `ui` edits made in a browser (they reach the server over sync);
   * `layout` a layout run; `file` a reload of the board file; `undo` an undo.
   */
  source: 'ops' | 'ui' | 'layout' | 'file' | 'undo' | 'sync';
  reason?: string;
  /** The proposal this batch came from, if it was reviewed. */
  proposalId?: string;
  /** The batch this one reverted. */
  undoes?: string;
  /** The batch that reverted this one. */
  undoneBy?: string;
  /** One line, e.g. `Added 4 nodes and 3 edges`. */
  summary: string;
  /** Touched node, edge and comment ids, each sorted. */
  nodeIds: string[];
  edgeIds: string[];
  /** Omitted when the batch touched no comment. */
  commentIds?: string[];
}

export const HistoryOptionsSchema = z.object({
  /** Only batches before this cursor (for paging backwards). */
  before: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  actor: IdSchema.optional(),
  /** Include pure layout and move batches. Off by default. */
  includeMoves: z.boolean().optional(),
  maxTokens: z.number().int().min(100).max(50_000).optional(),
});
export type HistoryOptions = z.infer<typeof HistoryOptionsSchema>;

export interface HistoryResult {
  boardId: string;
  cursor: number;
  /** The oldest cursor `snapshotAt` can still reconstruct. */
  earliest: number;
  /** Newest first. */
  batches: Batch[];
  text: string;
  tokens: number;
  truncated: boolean;
}

/**
 * What to undo: one batch, an actor's most recent batch, or everything an actor
 * did that is still in place. `last` and `all` consider only batches that
 * changed nodes or edges (not comment-only ones such as resolving a thread);
 * name a batch id to undo anything else.
 *
 * People may undo anything. An agent:
 * - may undo only its own batches, and not at all in `locked` mode;
 * - restores an item only where doing so would be `free` for it under the
 *   current policy (`classifyOps` on the restoring change); anything else is
 *   left as it is and reported as a conflict ("needs review: ...");
 * - never undoes the reviewed items of a batch that came from an accepted
 *   proposal: a person accepted them, so a person undoes them.
 */
export const UndoRequestSchema = z.union([
  z.object({ batchId: IdSchema }),
  z.object({ actorId: IdSchema, scope: z.enum(['last', 'all']) }),
]);
export type UndoRequest = z.infer<typeof UndoRequestSchema>;

export interface UndoResult {
  boardId: string;
  cursor: number;
  /** Batches that were reverted, newest first. */
  undone: string[];
  /**
   * Things left as they are because someone changed them after the batch being
   * undone. Undo never overwrites later work.
   */
  conflicts: Array<{ kind: 'node' | 'edge' | 'comment'; id: string; reason: string }>;
  text: string;
}

// ── Questions, listed ────────────────────────────────────────────────────────

export const AsksOptionsSchema = z.object({
  /** `open` (default) or every question still kept. */
  status: z.enum(['open', 'all']).optional(),
  maxTokens: z.number().int().min(100).max(50_000).optional(),
});
export type AsksOptions = z.infer<typeof AsksOptionsSchema>;

export interface AsksResult {
  boardId: string;
  /** Oldest first. */
  asks: Ask[];
  text: string;
  tokens: number;
  truncated: boolean;
}

// ── Inbox ────────────────────────────────────────────────────────────────────

/**
 * Something addressed to an actor: a mention, a reply in a thread it took part
 * in, an answer to its question, a decision on its proposal, or one of its
 * batches being undone. This is how feedback from people reaches an agent.
 */
export interface InboxItem {
  seq: number;
  at: string;
  kind: 'mention' | 'reply' | 'answer' | 'decision' | 'undone';
  from: string;
  /** One line that stands on its own. */
  summary: string;
  /** The comment text, the answer, or the reviewer's note. */
  body?: string;
  commentId?: string;
  thread?: string;
  nodeId?: string;
  askId?: string;
  proposalId?: string;
  batchId?: string;
}

export const InboxOptionsSchema = z.object({
  /** Only items after this inbox position. Omit for everything not yet seen. */
  since: z.number().int().min(0).optional(),
  /** Leave the returned items unseen. */
  peek: z.boolean().optional(),
  maxTokens: z.number().int().min(100).max(50_000).optional(),
});
export type InboxOptions = z.infer<typeof InboxOptionsSchema>;

export interface InboxResult {
  boardId: string;
  /** Inbox position after the returned items. */
  position: number;
  items: InboxItem[];
  /** Questions this actor asked that are still open. */
  openAsks: number;
  /** Proposals by this actor that are still pending. */
  pendingProposals: number;
  text: string;
  tokens: number;
  truncated: boolean;
}

export interface ProposalsResult {
  boardId: string;
  proposals: Proposal[];
  text: string;
  tokens: number;
  truncated: boolean;
}
