import type { Board } from '@openboard/core';
import { applyLayoutPatch, layoutIncremental } from '@openboard/server';

/**
 * Give every node without a position one, as the server does after each
 * change. Used when the CLI writes a board file itself, so a board made or
 * changed without a server opens laid out. Placed nodes do not move.
 */
export async function placeUnplaced(board: Board): Promise<Board> {
  if (!Object.values(board.nodes).some((node) => !node.view)) return board;
  return applyLayoutPatch(board, await layoutIncremental(board));
}
