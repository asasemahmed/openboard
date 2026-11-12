/** Questions agents ask people: which ones to show, in what order, with which answers. */
import type { AnswerInput, Ask } from '@openboard/core';

/** Open questions, oldest first: the one that has waited longest is answered first. */
export function openAsks(asks: readonly Ask[]): Ask[] {
  return asks
    .filter((ask) => ask.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export interface AskOption {
  label: string;
  /** Sent as `option`. */
  value: string;
  primary: boolean;
}

/** Fallback answers for an approval that came without options of its own. */
export const APPROVAL_OPTIONS = ['Approve', 'Decline'] as const;

/**
 * The answer buttons for a question. Options are labelled as the agent wrote
 * them. Only an approval gets a primary button, and only its first option.
 */
export function askOptions(ask: Pick<Ask, 'kind' | 'options'>): AskOption[] {
  const given = ask.options ?? [];
  const values = given.length > 0 ? given : ask.kind === 'approval' ? [...APPROVAL_OPTIONS] : [];
  return values.map((value, i) => ({
    label: value,
    value,
    primary: ask.kind === 'approval' && i === 0,
  }));
}

/** The request body for an answer: an option, a text, or both. Null when there is nothing to send. */
export function answerPayload(option: string | undefined, text: string): AnswerInput | null {
  const clean = text.trim();
  if (option === undefined && clean === '') return null;
  const out: AnswerInput = {};
  if (option !== undefined) out.option = option;
  if (clean !== '') out.text = clean.slice(0, 2000);
  return out;
}

/** Node ids that open questions point at, for the marker on those cards. */
export function askedNodes(asks: readonly Ask[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const ask of asks) {
    if (ask.status !== 'open') continue;
    for (const id of ask.nodeIds ?? []) out.set(id, [...(out.get(id) ?? []), ask.id]);
  }
  return out;
}
