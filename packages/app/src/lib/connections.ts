/**
 * Which connections the quiet view keeps out of sight. An agent can add dozens
 * of edges in one go, and drawn all at once they bury the cards; a person's
 * edges are few and deliberate. So in the quiet view an agent's edges wait
 * until the card they belong to is pointed at or selected, and a person's
 * always show.
 */
import type { Actor, BoardEdge } from '@openboard/core';

type Actors = Readonly<Record<string, Actor>>;

/** True for an edge an agent made. Edges of unknown origin count as a person's. */
export function isQuietEdge(edge: Pick<BoardEdge, 'createdBy'>, actors: Actors): boolean {
  return Object.hasOwn(actors, edge.createdBy) && actors[edge.createdBy]?.kind === 'agent';
}

/** Per node id, how many of its connections the quiet view holds back. */
export function quietCounts(
  edges: Iterable<Pick<BoardEdge, 'createdBy' | 'source' | 'target'>>,
  actors: Actors,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    if (!isQuietEdge(edge, actors)) continue;
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  return counts;
}
