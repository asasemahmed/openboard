/**
 * Three-way merge of two edits of a board, at field granularity, for a git
 * merge driver.
 *
 * For every node, edge and comment, and for the board's own fields: a field
 * one side left alone takes the other side's change; a field both sides
 * changed alike is fine; a field both changed differently is a conflict,
 * resolved in favour of `prefer` and reported. `view` is one field. `tags` and
 * `links` merge as sets and `props` per key, so independent additions on
 * both sides survive. Something removed on one side and changed on the other
 * is kept, so an edit is never lost silently; a change of position alone does
 * not count, because the layout engine moves nodes on its own.
 *
 * Afterwards the structure is repaired (see `repair.ts`), so the result is
 * always a valid board.
 */
import type { Actor, Board, BoardEdge, BoardNode, Comment, Link } from '../schema.js';
import { LIMITS } from '../schema.js';
import { compareStrings, jsonEqual, normalizeEdge, normalizeNode } from '../util.js';
import { type MergeContext, titleIn } from './context.js';
import { repairStructure } from './repair.js';
import { edgePhrase, quoted, show } from './report.js';
import type { MergeConflict, MergeOptions, MergeResult, MergeSide } from './types.js';
import { merge3, merge3Keep, mergeKeyedList, mergeRecord } from './values.js';

const NODE_FIELDS = [
  'type',
  'title',
  'body',
  'status',
  'parent',
  'tags',
  'links',
  'props',
  'view',
] as const;
const EDGE_FIELDS = ['type', 'source', 'target', 'label'] as const;

type Rec = Record<string, unknown>;
type Ctx = MergeContext;

function stamp(item: { updatedAt: string; updatedBy: string }): string {
  return `${item.updatedAt}\u0000${item.updatedBy}`;
}

/** The later of two bookkeeping stamps; the same answer whichever side is which. */
function later<T extends { updatedAt: string; updatedBy: string }>(a: T, b: T): T {
  return compareStrings(stamp(a), stamp(b)) >= 0 ? a : b;
}

/** Everything but position and bookkeeping: what counts as an edit for remove-versus-change. */
function meaning(item: Rec): Rec {
  const { view: _v, updatedAt: _a, updatedBy: _b, ...rest } = item;
  return rest;
}

/**
 * Bookkeeping of a merged item: `createdAt/By` from the earliest creation,
 * `updatedAt/By` from the side that changed it last, never from the merge.
 */
function bookkeeping<
  T extends { createdAt: string; createdBy: string; updatedAt: string; updatedBy: string },
>(
  base: T | undefined,
  ours: T,
  theirs: T,
): Pick<T, 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'> {
  const created =
    compareStrings(
      `${ours.createdAt}\u0000${ours.createdBy}`,
      `${theirs.createdAt}\u0000${theirs.createdBy}`,
    ) <= 0
      ? ours
      : theirs;
  const oursChanged = !base || stamp(base) !== stamp(ours);
  const theirsChanged = !base || stamp(base) !== stamp(theirs);
  const updated =
    oursChanged && theirsChanged
      ? later(ours, theirs)
      : oursChanged
        ? ours
        : theirsChanged
          ? theirs
          : ours;
  return {
    createdAt: created.createdAt,
    createdBy: created.createdBy,
    updatedAt: updated.updatedAt,
    updatedBy: updated.updatedBy,
  };
}

function linkKey(link: Link): string {
  return `${link.kind}\u0000${link.target}`;
}

// ── Nodes ────────────────────────────────────────────────────────────────────

function mergeNodeFields(
  ctx: Ctx,
  id: string,
  base: BoardNode | undefined,
  ours: BoardNode,
  theirs: BoardNode,
): BoardNode {
  const b = (base ?? {}) as Rec;
  const o = ours as Rec;
  const t = theirs as Rec;
  const out: Rec = { id };
  const title = quoted(titleIn([ctx.ours, ctx.theirs, ctx.base], id));
  const report = (field: string, ov: unknown, tv: unknown) =>
    ctx.conflicts.push({
      kind: 'node',
      id,
      field,
      ours: ov,
      theirs: tv,
      resolution: ctx.prefer,
      message: base
        ? `Both sides changed the ${field} of ${title} (ours: ${show(ov)}, theirs: ${show(tv)}); kept ${ctx.prefer}.`
        : `Both sides added ${title} with a different ${field} (ours: ${show(ov)}, theirs: ${show(tv)}); kept ${ctx.prefer}.`,
    });

  let viewFrom: MergeSide | undefined;
  for (const field of NODE_FIELDS) {
    if (field === 'view') continue;
    if (field === 'tags') {
      const merged = mergeKeyedList(
        b.tags as string[] | undefined,
        o.tags as string[] | undefined,
        t.tags as string[] | undefined,
        (tag) => tag,
        ctx.prefer,
      );
      let value = merged.value;
      if (value && value.length > LIMITS.tagsPerNode) {
        value = (ctx.prefer === 'ours' ? o.tags : t.tags) as string[] | undefined;
        merged.conflict = true;
      }
      if (merged.conflict) report('tags', o.tags, t.tags);
      if (value !== undefined) out.tags = value;
      continue;
    }
    if (field === 'links') {
      const merged = mergeKeyedList(
        b.links as Link[] | undefined,
        o.links as Link[] | undefined,
        t.links as Link[] | undefined,
        linkKey,
        ctx.prefer,
      );
      let value = merged.value;
      if (value && value.length > LIMITS.linksPerNode) {
        value = (ctx.prefer === 'ours' ? o.links : t.links) as Link[] | undefined;
        merged.conflict = true;
      }
      if (merged.conflict) report('links', o.links, t.links);
      if (value !== undefined) out.links = value;
      continue;
    }
    if (field === 'props') {
      const merged = mergeRecord(
        b.props as Rec | undefined,
        o.props as Rec | undefined,
        t.props as Rec | undefined,
        ctx.prefer,
      );
      for (const key of merged.conflicts) {
        report(
          `props.${key}`,
          (o.props as Rec | undefined)?.[key],
          (t.props as Rec | undefined)?.[key],
        );
      }
      if (merged.value !== undefined) out.props = merged.value;
      continue;
    }
    const picked = merge3(b[field], o[field], t[field], ctx.prefer);
    if (picked.conflict) report(field, o[field], t[field]);
    if (picked.value !== undefined) out[field] = picked.value;
    if (field === 'parent' && (picked.from === 'ours' || picked.from === 'theirs')) {
      // A position is relative to its frame: it travels with the side whose frame won.
      viewFrom = picked.from;
    }
  }

  if (viewFrom) {
    const view = viewFrom === 'ours' ? o.view : t.view;
    if (view !== undefined) out.view = view;
  } else {
    const picked = merge3(b.view, o.view, t.view, ctx.prefer);
    if (picked.conflict) {
      ctx.conflicts.push({
        kind: 'node',
        id,
        field: 'view',
        ours: o.view,
        theirs: t.view,
        resolution: ctx.prefer,
        message: `Both sides ${base ? 'moved or resized' : 'placed'} ${title} differently; kept the ${ctx.prefer === 'ours' ? 'our' : 'their'} position.`,
      });
    }
    if (picked.value !== undefined) out.view = picked.value;
  }
  return normalizeNode({ ...(out as unknown as BoardNode), ...bookkeeping(base, ours, theirs) });
}

function mergeNodes(ctx: Ctx): Record<string, BoardNode> {
  const out: Record<string, BoardNode> = {};
  const ids = unionKeys(ctx.base.nodes, ctx.ours.nodes, ctx.theirs.nodes);
  for (const id of ids) {
    const b = ctx.base.nodes[id];
    const o = ctx.ours.nodes[id];
    const t = ctx.theirs.nodes[id];
    if (o && t) {
      out[id] = jsonEqual(o, t) ? o : mergeNodeFields(ctx, id, b, o, t);
      continue;
    }
    const kept = o ?? t;
    if (!kept) continue; // removed on both sides
    if (!b) {
      out[id] = kept; // added on one side
      continue;
    }
    if (jsonEqual(meaning(b), meaning(kept))) continue; // removed on one side, at most moved on the other
    const removedBy: MergeSide = o ? 'theirs' : 'ours';
    const changedBy: MergeSide = o ? 'ours' : 'theirs';
    out[id] = kept;
    ctx.conflicts.push({
      kind: 'node',
      id,
      ours: o,
      theirs: t,
      resolution: 'kept',
      message: `${quoted(kept.title)} was removed by ${removedBy} but changed by ${changedBy}; it was kept, so remove it again if it should go.`,
    });
  }
  return out;
}

// ── Edges ────────────────────────────────────────────────────────────────────

function mergeEdgeFields(
  ctx: Ctx,
  id: string,
  base: BoardEdge | undefined,
  ours: BoardEdge,
  theirs: BoardEdge,
): BoardEdge {
  const b = (base ?? {}) as Rec;
  const o = ours as Rec;
  const t = theirs as Rec;
  const out: Rec = { id };
  const boards = [ctx.ours, ctx.theirs, ctx.base];
  for (const field of EDGE_FIELDS) {
    const picked = merge3(b[field], o[field], t[field], ctx.prefer);
    if (picked.conflict) {
      const phrase = edgePhrase(
        ours.type,
        titleIn(boards, ours.source),
        titleIn(boards, ours.target),
      );
      ctx.conflicts.push({
        kind: 'edge',
        id,
        field,
        ours: o[field],
        theirs: t[field],
        resolution: ctx.prefer,
        message: `Both sides ${base ? 'changed' : 'added'} the ${field} of ${phrase} differently (ours: ${show(o[field])}, theirs: ${show(t[field])}); kept ${ctx.prefer}.`,
      });
    }
    if (picked.value !== undefined) out[field] = picked.value;
  }
  return normalizeEdge({ ...(out as unknown as BoardEdge), ...bookkeeping(base, ours, theirs) });
}

function mergeEdges(ctx: Ctx, nodes: Record<string, BoardNode>): Record<string, BoardEdge> {
  const out: Record<string, BoardEdge> = {};
  const boards = [ctx.ours, ctx.theirs, ctx.base];
  for (const id of unionKeys(ctx.base.edges, ctx.ours.edges, ctx.theirs.edges)) {
    const b = ctx.base.edges[id];
    const o = ctx.ours.edges[id];
    const t = ctx.theirs.edges[id];
    if (o && t) {
      out[id] = jsonEqual(o, t) ? o : mergeEdgeFields(ctx, id, b, o, t);
      continue;
    }
    const kept = o ?? t;
    if (!kept) continue;
    if (!b) {
      out[id] = kept;
      continue;
    }
    const removedBy = o ? ctx.theirs : ctx.ours;
    if (jsonEqual(b, kept)) {
      // Removed on one side. When that was only because its node went, and the
      // node survives the merge (it was changed on the other side), the edge stays too.
      const collateral = [kept.source, kept.target].some((end) => !removedBy.nodes[end]);
      if (collateral && nodes[kept.source] && nodes[kept.target]) out[id] = kept;
      continue;
    }
    out[id] = kept;
    const phrase = edgePhrase(
      kept.type,
      titleIn(boards, kept.source),
      titleIn(boards, kept.target),
    );
    ctx.conflicts.push({
      kind: 'edge',
      id,
      ours: o,
      theirs: t,
      resolution: 'kept',
      message: `${capitalize(phrase)} was removed by ${o ? 'theirs' : 'ours'} but changed by ${o ? 'ours' : 'theirs'}; it was kept, so remove it again if it should go.`,
    });
  }
  return out;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Comments ─────────────────────────────────────────────────────────────────

function mergeComments(ctx: Ctx): Record<string, Comment> {
  const base = ctx.base.comments ?? {};
  const ours = ctx.ours.comments ?? {};
  const theirs = ctx.theirs.comments ?? {};
  const boards = [ctx.ours, ctx.theirs, ctx.base];
  const out: Record<string, Comment> = {};
  for (const id of unionKeys(base, ours, theirs)) {
    const b = base[id];
    const o = ours[id];
    const t = theirs[id];
    const where = (c: Comment) =>
      c.nodeId !== undefined ? `on ${quoted(titleIn(boards, c.nodeId))}` : 'on the board';
    if (o && t) {
      if (jsonEqual(o, t)) {
        out[id] = o;
        continue;
      }
      const merged: Rec = {};
      const bRec = (b ?? {}) as Rec;
      const keys = [...new Set([...Object.keys(bRec), ...Object.keys(o), ...Object.keys(t)])].sort(
        compareStrings,
      );
      for (const key of keys) {
        const ov = (o as Rec)[key];
        const tv = (t as Rec)[key];
        const picked = merge3(bRec[key], ov, tv, ctx.prefer);
        if (picked.conflict) {
          ctx.conflicts.push({
            kind: 'comment',
            id,
            field: key,
            ours: ov,
            theirs: tv,
            resolution: ctx.prefer,
            message: `Both sides changed the ${key} of a comment ${where(o)} differently (ours: ${show(ov)}, theirs: ${show(tv)}); kept ${ctx.prefer}.`,
          });
        }
        if (picked.value !== undefined) merged[key] = picked.value;
      }
      out[id] = merged as unknown as Comment;
      continue;
    }
    const kept = o ?? t;
    if (!kept) continue;
    if (!b) {
      out[id] = kept;
      continue;
    }
    if (jsonEqual(b, kept)) continue;
    out[id] = kept;
    ctx.conflicts.push({
      kind: 'comment',
      id,
      ours: o,
      theirs: t,
      resolution: 'kept',
      message: `A comment ${where(kept)} was removed by ${o ? 'theirs' : 'ours'} but edited by ${o ? 'ours' : 'theirs'}; it was kept, so remove it again if it should go.`,
    });
  }
  return out;
}

// ── Actors and board fields ──────────────────────────────────────────────────

function mergeActors(ctx: Ctx): Record<string, Actor> {
  const out: Record<string, Actor> = {};
  for (const id of unionKeys(ctx.base.actors, ctx.ours.actors, ctx.theirs.actors)) {
    const picked = merge3Keep(
      ctx.base.actors[id],
      ctx.ours.actors[id],
      ctx.theirs.actors[id],
      ctx.prefer,
    );
    // The registry is a union: an actor stays known once anyone has seen them.
    const value =
      picked.value ?? ctx.ours.actors[id] ?? ctx.theirs.actors[id] ?? ctx.base.actors[id];
    if (picked.conflict && ctx.ours.actors[id] && ctx.theirs.actors[id]) {
      ctx.conflicts.push({
        kind: 'meta',
        id,
        field: 'actors',
        ours: ctx.ours.actors[id],
        theirs: ctx.theirs.actors[id],
        resolution: ctx.prefer,
        message: `Both sides changed actor ${quoted(id)} differently (ours: ${show(ctx.ours.actors[id]?.name)}, theirs: ${show(ctx.theirs.actors[id]?.name)}); kept ${ctx.prefer}.`,
      });
    }
    if (value) out[id] = value;
  }
  return out;
}

function mergeMeta(
  ctx: Ctx,
  base: Board | null,
): Pick<Board, 'id' | 'name' | 'description' | 'createdAt' | 'updatedAt'> {
  const meta = {} as Rec;
  for (const field of ['id', 'name', 'description'] as const) {
    const b = base ? base[field] : undefined;
    const picked = merge3(b, ctx.ours[field], ctx.theirs[field], ctx.prefer);
    if (picked.conflict) {
      const what =
        field === 'id'
          ? 'the board id'
          : field === 'name'
            ? 'the board name'
            : 'the board description';
      ctx.conflicts.push({
        kind: 'meta',
        id: ctx.ours.id,
        field,
        ours: ctx.ours[field],
        theirs: ctx.theirs[field],
        resolution: ctx.prefer,
        message: `Both sides changed ${what} (ours: ${show(ctx.ours[field])}, theirs: ${show(ctx.theirs[field])}); kept ${ctx.prefer}.`,
      });
    }
    if (picked.value !== undefined) meta[field] = picked.value;
  }
  const created = merge3(base?.createdAt, ctx.ours.createdAt, ctx.theirs.createdAt, ctx.prefer);
  // Two different creation times have no meaningful winner: the board is as old as its oldest side.
  meta.createdAt = created.conflict
    ? [ctx.ours.createdAt, ctx.theirs.createdAt].sort(compareStrings)[0]
    : created.value;
  meta.updatedAt =
    compareStrings(ctx.ours.updatedAt, ctx.theirs.updatedAt) >= 0
      ? ctx.ours.updatedAt
      : ctx.theirs.updatedAt;
  return meta as Pick<Board, 'id' | 'name' | 'description' | 'createdAt' | 'updatedAt'>;
}

function unionKeys(...records: Array<Record<string, unknown>>): string[] {
  const keys = new Set<string>();
  for (const record of records) for (const key of Object.keys(record)) keys.add(key);
  return [...keys].sort(compareStrings);
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort(compareStrings)) out[key] = record[key] as T;
  return out;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Merge `ours` and `theirs`, two edits of `base`. `base` may be null when the
 * two have no common ancestor; it then counts as an empty board.
 */
export function mergeBoards(
  base: Board | null,
  ours: Board,
  theirs: Board,
  options: MergeOptions = {},
): MergeResult {
  const prefer: MergeSide = options.prefer === 'theirs' ? 'theirs' : 'ours';
  const ctx: Ctx = {
    base: base ?? {
      ...ours,
      actors: {},
      nodes: {},
      edges: {},
      comments: {},
    },
    ours,
    theirs,
    prefer,
    conflicts: [],
  };

  const meta = mergeMeta(ctx, base);
  const actors = mergeActors(ctx);
  const nodes = mergeNodes(ctx);
  const edges = mergeEdges(ctx, nodes);
  const comments = mergeComments(ctx);
  const repaired = repairStructure(ctx, nodes, edges, comments);

  const board: Board = {
    schemaVersion: ours.schemaVersion,
    id: meta.id,
    name: meta.name,
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    actors: sorted(actors),
    nodes: sorted(repaired.nodes),
    edges: sorted(repaired.edges),
    ...(Object.keys(repaired.comments).length > 0 ? { comments: sorted(repaired.comments) } : {}),
  };
  return { board, conflicts: ctx.conflicts, clean: ctx.conflicts.length === 0 };
}
