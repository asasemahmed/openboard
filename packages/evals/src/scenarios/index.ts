import type { Scenario } from '../types.js';
import { askBeforeDestructive } from './ask.js';
import { sharedBoardClaims } from './claims.js';
import { keepBoardTrueToCode } from './code-links.js';
import { incrementalUpdate } from './incremental.js';
import { findAndUpdateOnLargeBoard } from './large-board.js';
import { mapSmallRepo } from './map-small-repo.js';
import { noticeMidRunMention } from './mention.js';
import { planFeature } from './plan-feature.js';
import { learnFromRejection, respectReview } from './review.js';
import { selectionAsContext } from './selection.js';
import { untrustedContent } from './untrusted.js';

/** Every built-in scenario, in the order reports list them. */
export const SCENARIOS: readonly Scenario[] = [
  mapSmallRepo,
  planFeature,
  findAndUpdateOnLargeBoard,
  selectionAsContext,
  respectReview,
  learnFromRejection,
  askBeforeDestructive,
  keepBoardTrueToCode,
  sharedBoardClaims,
  incrementalUpdate,
  untrustedContent,
  noticeMidRunMention,
];

/** Scenarios by id and tag; unknown ids are an error. */
export function selectScenarios(options: { ids?: string[]; tags?: string[] } = {}): Scenario[] {
  const unknown = (options.ids ?? []).filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `unknown scenario ${unknown.join(', ')}; known: ${SCENARIOS.map((s) => s.id).join(', ')}`,
    );
  }
  return SCENARIOS.filter(
    (s) =>
      (!options.ids?.length || options.ids.includes(s.id)) &&
      (!options.tags?.length || options.tags.some((tag) => s.tags.includes(tag))),
  );
}

export {
  askBeforeDestructive,
  findAndUpdateOnLargeBoard,
  incrementalUpdate,
  keepBoardTrueToCode,
  learnFromRejection,
  mapSmallRepo,
  noticeMidRunMention,
  planFeature,
  respectReview,
  selectionAsContext,
  sharedBoardClaims,
  untrustedContent,
};
