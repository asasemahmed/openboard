/**
 * What on a board needs a person's attention: a few simple checks over the
 * graph, each easy to explain and quiet on a normal board.
 *
 * - `unanswered_question`: a question that is not done or cancelled, and that
 *   no decision is linked to (a decision with no status, or done, answers it).
 * - `unmitigated_risk`: a risk that is not done or cancelled, and that no task
 *   or decision (other than a cancelled one) is linked to.
 * - `blocked_but_clear`: a card marked blocked whose blockers (`blocks` edges
 *   into it, `depends_on` edges out of it) are all done or cancelled.
 * - `loose_card`: a card outside every frame with no connections, on a board
 *   where nearly every other card sits in a frame or is connected. A card
 *   with another finding is not listed again as loose.
 *
 * Links count in either direction and whatever their type, since boards link
 * questions, risks and their answers with `relates_to` as often as anything.
 * Pure: no network, no clock.
 */
import type { Board, BoardEdge, BoardNode, Status } from './schema.js';
import { compareStrings } from './util.js';

export const HEALTH_KINDS = [
  'unanswered_question',
  'unmitigated_risk',
  'blocked_but_clear',
  'loose_card',
] as const;
export type HealthKind = (typeof HEALTH_KINDS)[number];

export interface HealthFinding {
  kind: HealthKind;
  /** The card the finding is about first, then any cards it names (the blockers). */
  nodeIds: string[];
  /** One short sentence for people. */
  reason: string;
}

/** Loose cards are only unusual on a board with at least this many cards... */
const LOOSE_MIN_CARDS = 6;
/** ...and when at most this share of them is loose. */
const LOOSE_MAX_SHARE = 0.2;

const CLOSED: ReadonlySet<Status | undefined> = new Set<Status | undefined>(['done', 'cancelled']);

function short(title: string, max = 60): string {
  const line = title.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Findings for `board`, ordered by kind (as in `HEALTH_KINDS`), then by title.
 * Frames are never findings. An empty list means nothing needs attention.
 */
export function boardHealth(board: Pick<Board, 'nodes' | 'edges'>): HealthFinding[] {
  const nodes = board.nodes;
  const linked = new Map<string, BoardNode[]>();
  const blockers = new Map<string, BoardNode[]>();
  const link = (from: string, to: BoardNode) => {
    const list = linked.get(from);
    if (list) list.push(to);
    else linked.set(from, [to]);
  };
  const blockedBy = (id: string, blocker: BoardNode) => {
    const list = blockers.get(id);
    if (list) list.push(blocker);
    else blockers.set(id, [blocker]);
  };
  for (const edge of Object.values(board.edges) as BoardEdge[]) {
    const source = nodes[edge.source];
    const target = nodes[edge.target];
    if (!source || !target) continue;
    link(source.id, target);
    link(target.id, source);
    if (edge.type === 'blocks') blockedBy(target.id, source);
    else if (edge.type === 'depends_on') blockedBy(source.id, target);
  }

  const findings: HealthFinding[] = [];
  const cards = Object.values(nodes).filter((node) => node.type !== 'frame');

  for (const node of cards) {
    const neighbours = linked.get(node.id) ?? [];
    if (node.type === 'question' && !CLOSED.has(node.status)) {
      const answered = neighbours.some(
        (other) => other.type === 'decision' && (!other.status || other.status === 'done'),
      );
      if (!answered)
        findings.push({
          kind: 'unanswered_question',
          nodeIds: [node.id],
          reason: 'No decision answers it, and it is not marked done.',
        });
    }
    if (node.type === 'risk' && !CLOSED.has(node.status)) {
      const covered = neighbours.some(
        (other) =>
          (other.type === 'task' || other.type === 'decision') && other.status !== 'cancelled',
      );
      if (!covered)
        findings.push({
          kind: 'unmitigated_risk',
          nodeIds: [node.id],
          reason: 'No task or decision is linked to it.',
        });
    }
    if (node.status === 'blocked') {
      const list = [...new Map((blockers.get(node.id) ?? []).map((b) => [b.id, b])).values()];
      if (list.length > 0 && list.every((b) => CLOSED.has(b.status))) {
        const [only] = list;
        findings.push({
          kind: 'blocked_but_clear',
          nodeIds: [node.id, ...list.map((b) => b.id).sort(compareStrings)],
          reason:
            list.length === 1 && only
              ? `Marked blocked, but “${short(only.title)}” is ${only.status === 'done' ? 'done' : 'cancelled'}.`
              : `Marked blocked, but all ${list.length} cards it waits on are done or cancelled.`,
        });
      }
    }
  }

  const loose = cards.filter((node) => !node.parent && !linked.has(node.id));
  if (cards.length >= LOOSE_MIN_CARDS && loose.length <= cards.length * LOOSE_MAX_SHARE) {
    // A card listed already (an open question on its own, say) is not listed twice.
    const listed = new Set(findings.map((f) => f.nodeIds[0]));
    for (const node of loose) {
      if (listed.has(node.id)) continue;
      findings.push({
        kind: 'loose_card',
        nodeIds: [node.id],
        reason: 'Not in a frame and not connected to anything.',
      });
    }
  }

  const rank = new Map<string, number>(HEALTH_KINDS.map((kind, i) => [kind, i]));
  const title = (f: HealthFinding) => nodes[f.nodeIds[0] as string]?.title ?? '';
  return findings.sort(
    (a, b) =>
      (rank.get(a.kind) ?? 0) - (rank.get(b.kind) ?? 0) ||
      compareStrings(title(a), title(b)) ||
      compareStrings(a.nodeIds[0] as string, b.nodeIds[0] as string),
  );
}
