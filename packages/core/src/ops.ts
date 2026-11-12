/**
 * Operations: the only way meaning on a board changes.
 *
 * A batch of operations is one intent ("add these four tasks under this goal
 * and connect them"). A batch is validated as a whole and applied atomically:
 * either every operation lands or none does.
 *
 * Inside a batch, an `add_node` may declare a `ref` (for example "api"). Later
 * operations in the same batch can then point at that node as "$api" wherever a
 * node id is expected, before the real id exists.
 */
import { z } from 'zod';
import {
  EdgeInputSchema,
  EdgeTypeSchema,
  IdSchema,
  LIMITS,
  NodeInputSchema,
  ViewSchema,
} from './schema.js';

const RefSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'invalid ref');

/** A real id, or "$ref" pointing at a node created earlier in the same batch. */
export const NodeTargetSchema = z.union([
  IdSchema,
  z.string().regex(/^\$[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'invalid $ref'),
]);

const NodeInputWithRefs = NodeInputSchema.extend({ parent: NodeTargetSchema.optional() });

/** `null` clears an optional field; an absent key leaves it untouched. */
const NodePatchSchema = z
  .object({
    type: NodeInputSchema.shape.type,
    title: NodeInputSchema.shape.title,
    body: NodeInputSchema.shape.body.nullable(),
    status: NodeInputSchema.shape.status.nullable(),
    parent: NodeTargetSchema.nullable(),
    tags: NodeInputSchema.shape.tags.nullable(),
    props: NodeInputSchema.shape.props.nullable(),
    links: NodeInputSchema.shape.links.nullable(),
  })
  .partial();
export type NodePatch = z.infer<typeof NodePatchSchema>;

const EdgePatchSchema = z
  .object({
    type: EdgeTypeSchema,
    label: z.string().max(LIMITS.label).nullable(),
  })
  .partial();
export type EdgePatch = z.infer<typeof EdgePatchSchema>;

export const AddNodeOpSchema = z.object({
  op: z.literal('add_node'),
  /** Name this node so later ops in the batch can refer to it as "$<ref>". */
  ref: RefSchema.optional(),
  /** Supply an id only when you need a stable one; otherwise it is generated. */
  id: IdSchema.optional(),
  node: NodeInputWithRefs,
});

export const UpdateNodeOpSchema = z.object({
  op: z.literal('update_node'),
  id: NodeTargetSchema,
  patch: NodePatchSchema,
});

export const RemoveNodeOpSchema = z.object({
  op: z.literal('remove_node'),
  id: IdSchema,
  /**
   * What happens to the children of a removed frame. `reparent` (default) moves
   * them to the frame's own parent; `cascade` removes them too.
   */
  children: z.enum(['reparent', 'cascade']).optional(),
});

/** Presentation-only change. Never bumps `updatedAt`. */
export const MoveNodeOpSchema = z.object({
  op: z.literal('move_node'),
  id: NodeTargetSchema,
  view: ViewSchema.partial(),
});

export const AddEdgeOpSchema = z.object({
  op: z.literal('add_edge'),
  id: IdSchema.optional(),
  edge: EdgeInputSchema.extend({ source: NodeTargetSchema, target: NodeTargetSchema }),
});

export const UpdateEdgeOpSchema = z.object({
  op: z.literal('update_edge'),
  id: IdSchema,
  patch: EdgePatchSchema,
});

export const RemoveEdgeOpSchema = z.object({
  op: z.literal('remove_edge'),
  id: IdSchema,
});

export const OpSchema = z.discriminatedUnion('op', [
  AddNodeOpSchema,
  UpdateNodeOpSchema,
  RemoveNodeOpSchema,
  MoveNodeOpSchema,
  AddEdgeOpSchema,
  UpdateEdgeOpSchema,
  RemoveEdgeOpSchema,
]);
export type Op = z.infer<typeof OpSchema>;
export type OpKind = Op['op'];

export const OpBatchSchema = z.array(OpSchema).min(1).max(LIMITS.opsPerBatch);

/** Why one operation in a batch was refused. `index` is its position in the batch. */
export interface OpError {
  index: number;
  code:
    | 'invalid'
    | 'not_found'
    | 'duplicate_id'
    | 'unknown_ref'
    | 'duplicate_ref'
    | 'not_a_frame'
    | 'cycle'
    | 'self_edge'
    | 'duplicate_edge'
    | 'forbidden';
  message: string;
}

/** What a successfully applied batch did. */
export interface AppliedOps {
  /** Ids generated for `ref`s declared in the batch. */
  refs: Record<string, string>;
  addedNodes: string[];
  updatedNodes: string[];
  removedNodes: string[];
  addedEdges: string[];
  updatedEdges: string[];
  removedEdges: string[];
}
