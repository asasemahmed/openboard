/**
 * Authorship over sync in shared mode.
 *
 * Editors' browsers write to the board document directly, so a client could
 * claim that someone else wrote a node, a comment or an answer. The CRDT has
 * to accept the update as it is (refusing part of it would split the
 * replicas), so the server corrects it right afterwards, in a follow-up
 * transaction that every replica receives:
 *
 * - nodes, edges and comments created in the update carry the connection's
 *   actor as `createdBy`/`updatedBy`/`author`;
 * - an existing node or edge whose `updatedBy` was set to someone else gets the
 *   connection's actor; a changed `createdBy`/`createdAt` (or a comment's
 *   `author`/`createdAt`) is put back; a `resolvedBy` naming someone else
 *   becomes the connection's actor;
 * - actor registry entries other than the connection's own are put back, and
 *   its own is set to the actor the connection signed in as;
 * - questions and proposals are never created, answered or decided through
 *   the document: any change to them over sync is reverted.
 *
 * The correction is merged into the history batch of the update it corrects,
 * so it adds no batch, and it is a local transaction, which this guard never
 * inspects, so it cannot loop. Local mode does not use the guard.
 */
import type {
  Actor,
  Ask,
  BoardEdge,
  BoardNode,
  Comment,
  DocEvent,
  Proposal,
} from '@openboard/core';
import { errorMessage } from './fsutil.js';
import { jsonEqual } from './json.js';
import type { Room } from './room.js';

export function guardAuthorship(room: Room, log: (line: string) => void = () => {}): () => void {
  // What the server last wrote, to put questions and proposals back to.
  const asks = new Map<string, Ask>(room.doc.asks().map((a) => [a.id, a]));
  const proposals = new Map<string, Proposal>(room.doc.proposals().map((p) => [p.id, p]));
  room.guardsSync = true;

  const off = room.doc.observe((event: DocEvent) => {
    const untrusted = !event.local && event.origin?.source === 'sync';
    if (!untrusted) {
      for (const id of event.asks ?? []) {
        const ask = room.doc.getAsk(id);
        if (ask) asks.set(id, ask);
        else asks.delete(id);
      }
      for (const id of event.proposals ?? []) {
        const proposal = room.doc.getProposal(id);
        if (proposal) proposals.set(id, proposal);
        else proposals.delete(id);
      }
      return;
    }
    const actorId = (event.origin as NonNullable<DocEvent['origin']>).actorId;
    const batchId = room.lastBatchId;
    const fix = plan(room, event, actorId);
    const askIds = event.asks ?? [];
    const proposalIds = event.proposals ?? [];
    if (!fix && askIds.length === 0 && proposalIds.length === 0) return;
    // Written right after the update, before any other message is handled.
    queueMicrotask(() => {
      try {
        const doc = room.doc;
        if (fix) {
          room.withContext(batchId ? { mergeInto: batchId } : {}, () => {
            doc.ydoc.transact(
              () => {
                const actor = room.knownActors.get(actorId);
                if (actor) doc.registerActor(actor, doc.origin(actorId, 'sync'));
                for (const [id, value] of Object.entries(fix.actors)) {
                  if (value) doc.registerActor(value, doc.origin(actorId, 'sync'));
                  else doc.removeActor(id, doc.origin(actorId, 'sync'));
                }
                doc.restore(
                  { nodes: fix.nodes, edges: fix.edges, comments: fix.comments },
                  doc.origin(actorId, 'sync'),
                );
              },
              doc.origin(actorId, 'sync'),
            );
          });
        }
        const system = doc.origin('system', 'ops');
        for (const id of askIds) {
          const trusted = asks.get(id);
          if (trusted) doc.putAsk(trusted, system);
          else doc.deleteAsk(id, system);
        }
        for (const id of proposalIds) {
          const trusted = proposals.get(id);
          if (trusted) doc.putProposal(trusted, system);
          else doc.deleteProposal(id, system);
        }
        if (askIds.length || proposalIds.length) {
          log(
            `board "${room.id}": reverted a change to questions or proposals made by ${actorId} over sync`,
          );
        }
      } catch (error) {
        log(`board "${room.id}": could not correct authorship: ${errorMessage(error)}`);
      }
    });
  });
  return () => {
    off();
    room.guardsSync = false;
  };
}

interface Fix {
  nodes: Record<string, BoardNode>;
  edges: Record<string, BoardEdge>;
  comments: Record<string, Comment>;
  /** Registry entries to put back (null: the entry should not exist). */
  actors: Record<string, Actor | null>;
}

/** The corrections an untrusted update needs, or null when it needs none. */
function plan(room: Room, event: DocEvent, actorId: string): Fix | null {
  const states = event.states;
  if (!states) return null;
  const fix: Fix = { nodes: {}, edges: {}, comments: {}, actors: {} };
  let needed = false;

  const item = <T extends BoardNode | BoardEdge>(before: T | null, after: T | null): T | null => {
    if (!after) return null;
    const next = { ...after };
    if (!before) {
      next.createdBy = actorId;
      next.updatedBy = actorId;
    } else {
      next.createdBy = before.createdBy;
      next.createdAt = before.createdAt;
      if (after.updatedBy !== before.updatedBy && after.updatedBy !== actorId) {
        next.updatedBy = actorId;
      }
    }
    return jsonEqual(next, after) ? null : next;
  };
  for (const [id, state] of Object.entries(states.nodes)) {
    const next = item(state.before, state.after);
    if (next) {
      fix.nodes[id] = next;
      needed = true;
    }
  }
  for (const [id, state] of Object.entries(states.edges)) {
    const next = item(state.before, state.after);
    if (next) {
      fix.edges[id] = next;
      needed = true;
    }
  }
  for (const [id, state] of Object.entries(states.comments)) {
    const after = state.after;
    if (!after) continue;
    const next: Comment = { ...after };
    if (!state.before) next.author = actorId;
    else {
      next.author = state.before.author;
      next.createdAt = state.before.createdAt;
    }
    if (after.resolvedBy !== undefined && after.resolvedBy !== state.before?.resolvedBy) {
      next.resolvedBy = actorId;
    }
    if (!jsonEqual(next, after)) {
      fix.comments[id] = next;
      needed = true;
    }
  }
  for (const [id, state] of Object.entries(states.actors ?? {})) {
    const own = room.knownActors.get(actorId);
    const wanted = id === actorId ? (own ?? state.after) : state.before;
    if (!jsonEqual(wanted, state.after)) {
      fix.actors[id] = wanted ?? null;
      needed = true;
    }
  }
  return needed ? fix : null;
}
