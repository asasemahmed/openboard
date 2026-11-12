/**
 * Code links as people see them: which state each is in (live from the
 * document, with the server's details when it has been asked), what a card
 * shows, and what can be done with a link.
 */
import type { BoardNode, Link, LinkEntry, LinkState } from '@openboard/core';

export const CODE_KINDS: ReadonlySet<Link['kind']> = new Set(['file', 'symbol']);

/**
 * A link's state from the document alone. The server keeps `stale` and
 * `hash` current; it cannot tell "changed" from "missing" without its own
 * check, so both read as `stale` here until a detail arrives.
 */
export function localState(link: Link): LinkState {
  if (!CODE_KINDS.has(link.kind)) return 'unchecked';
  if (link.stale) return 'stale';
  return link.hash ? 'ok' : 'unchecked';
}

/** Links of a node that do not match the code any more. */
export function outOfDate(node: Pick<BoardNode, 'links'>): number {
  return (node.links ?? []).filter((l) => l.stale === true && CODE_KINDS.has(l.kind)).length;
}

export interface LinkView {
  link: Link;
  index: number;
  state: LinkState;
  /** One line for people, e.g. "Content changed at lines 3–5". */
  status: string;
  detail?: string;
  /** What the row offers. */
  canOpen: boolean;
  canRefresh: boolean;
  /** Draw the warning: the code changed, is gone, or the link points outside the project. */
  warn: boolean;
}

const STATUS: Record<LinkState, string> = {
  ok: 'Up to date',
  stale: 'Code changed',
  missing: 'File missing',
  outside: 'Outside the project',
  unchecked: '',
};

function sentence(text: string): string {
  const t = text.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * One row per link: the live state, refined by the server's entry for it when
 * there is one (the server knows "missing" and "outside" and says where).
 */
export function linkViews(
  node: Pick<BoardNode, 'id' | 'links'>,
  entries: readonly LinkEntry[] = [],
): LinkView[] {
  return (node.links ?? []).map((link, index) => {
    const entry = entries.find(
      (e) => e.nodeId === node.id && e.index === index && e.link.target === link.target,
    );
    let state = localState(link);
    // The server's answer wins, except that a link the document now says is fresh stays fresh.
    if (entry && !(state === 'ok' && entry.state === 'stale')) state = entry.state;
    if (state === 'ok' && link.stale) state = 'stale';
    const code = CODE_KINDS.has(link.kind);
    const view: LinkView = {
      link,
      index,
      state,
      status: entry?.detail ? sentence(entry.detail) : STATUS[state],
      canOpen: code && state !== 'outside',
      canRefresh: code && (state === 'stale' || state === 'missing'),
      warn: state === 'stale' || state === 'missing' || state === 'outside',
    };
    if (entry?.detail) view.detail = entry.detail;
    return view;
  });
}

export interface CodeMarker {
  /** Short text in the label row. */
  label: string;
  /** Spelled out for the tooltip and screen readers. */
  title: string;
}

/** What a card shows when its code moved on, or null when nothing did. */
export function codeMarker(node: Pick<BoardNode, 'links'>): CodeMarker | null {
  const n = outOfDate(node);
  if (n === 0) return null;
  return {
    label: 'Code changed',
    title:
      n === 1
        ? 'The linked code changed since this card was written. Open it to see where.'
        : `${n} linked files changed since this card was written. Open it to see where.`,
  };
}
