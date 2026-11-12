/**
 * What people do about agents' work, as calls on a session: decide on a
 * proposal, answer or withdraw a question, undo a batch. Each goes through
 * the REST API as this person; the document then brings the new state to
 * every browser, so nothing here updates local state by hand.
 */
import type { Decision, Proposal, UndoRequest, UndoResult } from '@openboard/core';
import { calmMessage } from '../lib/api.js';
import { type DecisionOutcome, decisionOutcome } from '../lib/review.js';
import type { BoardSession } from './session.js';

export const REVIEW_PANEL = 'review';
export const COMMENTS_PANEL = 'comments';
export const ACTIVITY_PANEL = 'activity';
export const AGENTS_PANEL = 'agents';

/** Show the review panel with this proposal in view. Focus stays where it is. */
export function openReview(session: BoardSession, proposalId?: string): void {
  session.ui.showRightPanel(REVIEW_PANEL);
  if (proposalId) session.ui.focusProposal.set({ id: proposalId, at: Date.now() });
}

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

export async function decide(
  session: BoardSession,
  proposal: Proposal,
  decision: Decision,
): Promise<Result<DecisionOutcome>> {
  try {
    const after = await session.api.decideProposal(session.boardId, proposal.id, decision);
    return { ok: true, value: decisionOutcome(proposal, after) };
  } catch (error) {
    return { ok: false, message: calmMessage(error, 'proposal') };
  }
}

export async function undoBatch(
  session: BoardSession,
  request: UndoRequest,
): Promise<Result<UndoResult>> {
  try {
    return { ok: true, value: await session.api.undo(session.boardId, request) };
  } catch (error) {
    return { ok: false, message: calmMessage(error, 'batch') };
  }
}
