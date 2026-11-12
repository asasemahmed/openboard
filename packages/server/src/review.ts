/**
 * Server-side work on proposals that needs the layout engine or a live room:
 * previews with positions for the ghosts, and keeping pending proposals honest
 * while the board changes under them.
 */
import {
  type Board,
  checkItems,
  type Proposal,
  type ProposalItem,
  type ProposalPreview,
  previewOf,
} from '@openboard/core';
import { errorMessage } from './fsutil.js';
import { jsonEqual } from './json.js';
import { layoutIncremental } from './layout/index.js';
import type { Room } from './room.js';

/** Give the preview's new nodes views from the layout engine, so ghosts appear where they would land. */
export async function placePreview(
  after: Board,
  preview: ProposalPreview,
  log: (line: string) => void,
): Promise<ProposalPreview> {
  if (Object.keys(preview.nodes).length === 0) return preview;
  try {
    const patch = await layoutIncremental(after);
    const nodes: ProposalPreview['nodes'] = {};
    for (const [id, node] of Object.entries(preview.nodes)) {
      const view = patch.get(id);
      nodes[id] = view ? { ...node, view } : node;
    }
    return { ...preview, nodes };
  } catch (error) {
    log(`layout for a proposal preview failed: ${errorMessage(error)}`);
    return preview;
  }
}

/**
 * Re-check one pending proposal against `board`: items whose target changed
 * or vanished, or that no longer validate, become conflicts (with what depends
 * on them), and the preview shows only what accepting the rest would do.
 * Returns the proposal unchanged (same object) when nothing differs.
 */
export async function refreshProposal(
  room: Room,
  board: Board,
  proposal: Proposal,
  log: (line: string) => void,
): Promise<Proposal> {
  const pending = proposal.items.filter((item) => item.status === 'pending').map((i) => i.index);
  const check = checkItems(board, proposal, pending, { actor: room.actorFor(proposal.author) });
  const conflicts = new Map(check.conflicts.map((c) => [c.index, c.reason]));
  const items = proposal.items.map((item): ProposalItem => {
    const reason = conflicts.get(item.index);
    return reason === undefined ? item : { ...item, status: 'conflict', conflict: reason };
  });
  const preview = await placePreview(
    check.outcome.board,
    previewOf(board, check.outcome.board, check.outcome.applied),
    log,
  );
  const next: Proposal = { ...proposal, items, preview };
  return jsonEqual(next, proposal) ? proposal : next;
}

/** Refresh every pending proposal of a room; run under the room's lock. */
export async function refreshProposals(room: Room, log: (line: string) => void): Promise<void> {
  const board = room.doc.toJSON();
  for (const proposal of room.doc.proposals()) {
    if (proposal.status !== 'pending') continue;
    const next = await refreshProposal(room, board, proposal, log);
    // Decided or withdrawn while the layout ran: leave it.
    if (next !== proposal && room.doc.getProposal(proposal.id)?.status === 'pending') {
      room.doc.putProposal(next, room.doc.origin('system', 'ops'));
    }
  }
}
