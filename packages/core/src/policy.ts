/**
 * The review policy as a pure function: what an agent's batch may do on its
 * own, what waits for a person, and what is refused. The rules are documented
 * on `PolicyModeSchema` and `FRAME_POLICY_PROP` in collab.ts.
 *
 * `classifyOps` expects a batch that already passed `applyOps`; it follows
 * the batch op by op (refs, parents, removals) without validating it again.
 */
import {
  FRAME_POLICY_PROP,
  type FramePolicy,
  FramePolicySchema,
  type OpVerdict,
  type PolicyMode,
  type ProjectConfig,
} from './collab.js';
import type { Op } from './ops.js';
import type { Actor, Board, BoardEdge, BoardNode } from './schema.js';

export interface OpClassification {
  index: number;
  verdict: OpVerdict;
  /** A short sentence for a person, set unless the verdict is `free`. */
  why?: string;
}

export interface PolicyContext {
  actor: Actor;
  config: ProjectConfig;
}

/** The mode that applies to an actor before frame overrides; people are always `auto`. */
export function policyModeFor(actor: Actor, config: ProjectConfig): PolicyMode {
  if (actor.kind !== 'agent') return 'auto';
  return config.policy.agents[actor.id] ?? config.policy.default;
}

/** The policy a frame sets through `FRAME_POLICY_PROP`, if it sets a valid one. */
export function framePolicyOf(
  node: Pick<BoardNode, 'type' | 'props'> | undefined,
): FramePolicy | undefined {
  if (node?.type !== 'frame') return undefined;
  const parsed = FramePolicySchema.safeParse(node.props?.[FRAME_POLICY_PROP]);
  return parsed.success ? parsed.data : undefined;
}

const RANK: Record<OpVerdict, number> = { free: 0, review: 1, denied: 2 };

interface Judgement {
  verdict: OpVerdict;
  why?: string;
}

const FREE: Judgement = { verdict: 'free' };

function worst(...judgements: Judgement[]): Judgement {
  let out = FREE;
  for (const j of judgements) if (RANK[j.verdict] > RANK[out.verdict]) out = j;
  return out;
}

/** What an operation does to one item, for the mode rules. */
type Action = 'add' | 'change' | 'move' | 'move_pinned';

/** A frame that sets a policy, as seen from some location. */
interface Zone {
  policy: FramePolicy;
  frameId: string;
  title: string;
}

const q = (text: string) => JSON.stringify(text);

/**
 * Classify each operation of `ops` for `ctx.actor` against `board`. People
 * (and the system) are never restricted: every operation is `free`.
 */
export function classifyOps(
  board: Board,
  ops: readonly Op[],
  ctx: PolicyContext,
): OpClassification[] {
  if (ctx.actor.kind !== 'agent') return ops.map((_op, index) => ({ index, verdict: 'free' }));
  // Frames can restrict even an `auto` agent, so every agent batch is walked.
  return new Classifier(board, ctx.actor, policyModeFor(ctx.actor, ctx.config)).run(ops);
}

class Classifier {
  /** Current parent of every node, following the batch. */
  private readonly parentOf = new Map<string, string | undefined>();
  /** Nodes present at this point of the batch, with their pre-batch state (or the state they were added with). */
  private readonly nodes = new Map<string, { title: string; type: string }>();
  private readonly edges = new Map<
    string,
    { id: string; source: string; target: string; type: string }
  >();
  private readonly created = new Set<string>();
  private readonly refs = new Map<string, string>();
  /** Frame policies: pre-batch for existing frames, as declared for frames added in the batch. */
  private readonly framePolicy = new Map<string, FramePolicy>();
  private readonly views = new Map<string, BoardNode['view']>();

  constructor(
    private readonly board: Board,
    private readonly actor: Actor,
    private readonly mode: PolicyMode,
  ) {
    for (const node of Object.values(board.nodes)) {
      this.nodes.set(node.id, node);
      this.parentOf.set(node.id, node.parent);
      this.views.set(node.id, node.view);
      const policy = framePolicyOf(node);
      if (policy) this.framePolicy.set(node.id, policy);
    }
    for (const edge of Object.values(board.edges)) this.edges.set(edge.id, edge);
  }

  run(ops: readonly Op[]): OpClassification[] {
    return ops.map((op, index) => {
      const judgement = this.step(op, index);
      const out: OpClassification = { index, verdict: judgement.verdict };
      if (judgement.verdict !== 'free' && judgement.why) out.why = judgement.why;
      return out;
    });
  }

  // ── Following the batch ────────────────────────────────────────────────────

  private resolve(target: string): string {
    return target.startsWith('$') ? (this.refs.get(target.slice(1)) ?? target) : target;
  }

  private title(id: string): string {
    return this.nodes.get(id)?.title ?? id;
  }

  private step(op: Op, index: number): Judgement {
    switch (op.op) {
      case 'add_node': {
        const id = op.id ?? (op.ref !== undefined ? `$${op.ref}` : `#${index}`);
        if (op.ref !== undefined) this.refs.set(op.ref, id);
        const parent = op.node.parent === undefined ? undefined : this.resolve(op.node.parent);
        const judgement = this.at(this.zoneOfLocation(parent), 'add', `adds ${q(op.node.title)}`);
        this.nodes.set(id, { title: op.node.title, type: op.node.type });
        this.parentOf.set(id, parent);
        this.views.set(id, op.node.view);
        this.created.add(id);
        const policy = framePolicyOf({
          type: op.node.type,
          ...(op.node.props ? { props: op.node.props } : {}),
        });
        if (policy) this.framePolicy.set(id, policy);
        return judgement;
      }
      case 'update_node': {
        const id = this.resolve(op.id);
        let judgement = this.change(id, 'change', `changes ${q(this.title(id))}`);
        if (op.patch.parent !== undefined) {
          const next = op.patch.parent === null ? undefined : this.resolve(op.patch.parent);
          judgement = worst(judgement, this.reparent(id, next));
          this.parentOf.set(id, next);
        }
        return judgement;
      }
      case 'move_node': {
        const id = this.resolve(op.id);
        const pinned = this.views.get(id)?.pinned === true;
        const judgement = this.change(
          id,
          pinned ? 'move_pinned' : 'move',
          pinned
            ? `moves ${q(this.title(id))}, which a person pinned in place`
            : `moves ${q(this.title(id))}`,
        );
        this.views.set(id, {
          ...(this.views.get(id) ?? { x: 0, y: 0 }),
          ...op.view,
        } as BoardNode['view']);
        return judgement;
      }
      case 'remove_node':
        return this.remove(op.id, op.children ?? 'reparent');
      case 'add_edge': {
        const source = this.resolve(op.edge.source);
        const target = this.resolve(op.edge.target);
        const id = op.id ?? `#${index}`;
        const what = `connects ${q(this.title(source))} to ${q(this.title(target))}`;
        const judgement = worst(
          this.at(this.zoneOfNode(source), 'add', what),
          this.at(this.zoneOfNode(target), 'add', what),
        );
        this.edges.set(id, { id, source, target, type: op.edge.type });
        this.created.add(id);
        return judgement;
      }
      case 'update_edge':
      case 'remove_edge': {
        const edge = this.edges.get(op.id);
        if (!edge) return FREE;
        const verb = op.op === 'update_edge' ? 'changes' : 'removes';
        const judgement = this.edgeChange(edge, verb);
        if (op.op === 'remove_edge') this.edges.delete(op.id);
        return judgement;
      }
    }
  }

  private remove(id: string, children: 'reparent' | 'cascade'): Judgement {
    const node = this.nodes.get(id);
    if (!node) return FREE;
    const judgements = [this.change(id, 'change', `removes ${q(node.title)}`)];
    const doomed = [id];
    const kids = (frame: string) =>
      [...this.parentOf].filter(([, parent]) => parent === frame).map(([child]) => child);
    if (node.type === 'frame') {
      if (children === 'cascade') {
        for (let i = 0; i < doomed.length; i++) {
          for (const child of kids(doomed[i] as string)) {
            doomed.push(child);
            judgements.push(
              this.change(child, 'change', `removes ${q(this.title(child))} with its frame`),
            );
          }
        }
      } else {
        const grandparent = this.parentOf.get(id);
        for (const child of kids(id)) {
          judgements.push(
            this.change(child, 'change', `lifts ${q(this.title(child))} out of the removed frame`),
            this.reparent(child, grandparent),
          );
          this.parentOf.set(child, grandparent);
        }
      }
    }
    const gone = new Set(doomed);
    for (const edge of [...this.edges.values()]) {
      if (!gone.has(edge.source) && !gone.has(edge.target)) continue;
      judgements.push(this.edgeChange(edge, 'removes'));
      this.edges.delete(edge.id);
    }
    for (const doomedId of doomed) {
      this.nodes.delete(doomedId);
      this.parentOf.delete(doomedId);
    }
    return worst(...judgements);
  }

  // ── Judging ────────────────────────────────────────────────────────────────

  /** The nearest frame with a policy that encloses a node placed under `parent`. */
  private zoneOfLocation(parent: string | undefined): Zone | undefined {
    const seen = new Set<string>();
    let current = parent;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const policy = this.framePolicy.get(current);
      if (policy) return { policy, frameId: current, title: this.title(current) };
      current = this.parentOf.get(current);
    }
    return undefined;
  }

  /** The zone of an existing node; a frame's own setting counts for itself. */
  private zoneOfNode(id: string): Zone | undefined {
    const own = this.framePolicy.get(id);
    if (own) return { policy: own, frameId: id, title: this.title(id) };
    return this.zoneOfLocation(this.parentOf.get(id));
  }

  /** Policy frames enclosing a location, nearest first. */
  private policyFramesAbove(parent: string | undefined): Zone[] {
    const out: Zone[] = [];
    const seen = new Set<string>();
    let current = parent;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const policy = this.framePolicy.get(current);
      if (policy) out.push({ policy, frameId: current, title: this.title(current) });
      current = this.parentOf.get(current);
    }
    return out;
  }

  /** Moving `id` from its current parent to `next`: frames it enters or leaves. */
  private reparent(id: string, next: string | undefined): Judgement {
    const before = this.policyFramesAbove(this.parentOf.get(id));
    const after = this.policyFramesAbove(next);
    const beforeIds = new Set(before.map((z) => z.frameId));
    const afterIds = new Set(after.map((z) => z.frameId));
    const judgements: Judgement[] = [];
    const title = q(this.title(id));
    for (const zone of after) {
      if (beforeIds.has(zone.frameId)) continue;
      if (zone.policy === 'locked')
        judgements.push({
          verdict: 'denied',
          why: `would move ${title} into the locked frame ${q(zone.title)}`,
        });
      else if (zone.policy === 'review')
        judgements.push({
          verdict: 'review',
          why: `moves ${title} into the review frame ${q(zone.title)}`,
        });
    }
    for (const zone of before) {
      if (afterIds.has(zone.frameId)) continue;
      if (zone.policy === 'locked')
        judgements.push({
          verdict: 'denied',
          why: `would move ${title} out of the locked frame ${q(zone.title)}`,
        });
      else if (zone.policy === 'review')
        judgements.push({
          verdict: 'review',
          why: `moves ${title} out of the review frame ${q(zone.title)}`,
        });
    }
    // A node added in this batch is judged as if it were added where it ends up.
    if (this.created.has(id))
      judgements.push(this.at(this.zoneOfLocation(next), 'add', `adds ${title}`));
    return worst(...judgements);
  }

  private change(id: string, action: Exclude<Action, 'add'>, what: string): Judgement {
    if (this.created.has(id)) return this.at(this.zoneOfNode(id), 'add', what);
    const node = this.board.nodes[id];
    return this.at(this.zoneOfNode(id), action, what, node);
  }

  private edgeChange(
    edge: { id: string; source: string; target: string },
    verb: string,
  ): Judgement {
    const what = `${verb} the edge from ${q(this.title(edge.source))} to ${q(this.title(edge.target))}`;
    const original = this.created.has(edge.id) ? undefined : this.board.edges[edge.id];
    const action: Action = original ? 'change' : 'add';
    return worst(
      this.at(this.zoneOfNode(edge.source), action, what, original),
      this.at(this.zoneOfNode(edge.target), action, what, original),
    );
  }

  /** The verdict for one action on one item (`item` is its pre-batch state, for ownership). */
  private at(
    zone: Zone | undefined,
    action: Action,
    what: string,
    item?: BoardNode | BoardEdge,
  ): Judgement {
    if (this.mode === 'locked') {
      return {
        verdict: 'denied',
        why: `this agent is locked: it may read the board but not change it (${what})`,
      };
    }
    if (zone?.policy === 'locked') {
      return {
        verdict: 'denied',
        why: `${what} inside the locked frame ${q(zone.title)}, which agents may not change`,
      };
    }
    if (zone?.policy === 'review') {
      return { verdict: 'review', why: `${what} inside the review frame ${q(zone.title)}` };
    }
    const mode: PolicyMode = zone?.policy === 'auto' ? 'auto' : this.mode;
    if (mode === 'auto') return FREE;
    if (mode === 'review_all')
      return { verdict: 'review', why: `${what}; every change by this agent waits for review` };
    // review_destructive
    if (action === 'add' || action === 'move') return FREE;
    if (action === 'move_pinned') return { verdict: 'review', why: what };
    if (item && item.createdBy === this.actor.id && item.updatedBy === this.actor.id) return FREE;
    if (!item) return FREE;
    const by = item.createdBy !== this.actor.id ? item.createdBy : item.updatedBy;
    const label = this.board.actors[by]?.name ?? by;
    const role = item.createdBy !== this.actor.id ? 'created' : 'edited last';
    return { verdict: 'review', why: `${what}, which ${label} ${role}` };
  }
}
