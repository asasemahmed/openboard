/**
 * Pending proposals on the canvas, over the ghosts the store draws: a quiet
 * dashed outline and author label around what each proposal adds, and a
 * small floating card next to it to accept or reject the whole proposal, or
 * open the review panel for item-by-item decisions.
 */
import type { Proposal } from '@openboard/core';
import { useStore } from '@xyflow/react';
import { memo, useMemo, useState } from 'react';
import { placementsOf } from '../lib/flow.js';
import { absoluteRect, boundsOf, type Rect } from '../lib/geometry.js';
import { placeControls, toScreen } from '../lib/overlay.js';
import { futureOutlines, type ProposalGroup, withFutureViews } from '../lib/review.js';
import { relativeTime } from '../lib/time.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { decide, openReview } from '../state/review.js';
import { toasts } from '../state/toasts.js';
import { Avatar } from '../ui/Avatar.js';
import { Icon } from '../ui/Icon.js';

const CONTROL = { w: 320, h: 96 };
const PAD = 12;

interface Placed {
  group: ProposalGroup;
  proposal: Proposal;
  /** Screen rect of what the proposal adds or touches. */
  rect: Rect;
  /** Only groups that add something get an outline; changes to cards carry their own marks. */
  outline: boolean;
}

export function ProposalLayer() {
  const session = useSession();
  const { store } = session;
  const review = useStoreValue(store, store.review);
  const nodes = useStoreValue(store, store.getNodes);
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);

  // Ghosts are not in the store's placements, so measure over every drawn node,
  // with existing nodes where accepting would put them (frames that grow).
  const now = useMemo(
    () => (review.groups.length > 0 ? placementsOf(nodes) : null),
    [nodes, review.groups.length],
  );
  const map = useMemo(
    () => (now ? withFutureViews(now, review.futureViews) : null),
    [now, review.futureViews],
  );
  const future = useMemo(
    () => (now ? futureOutlines(now, review.futureViews) : []),
    [now, review.futureViews],
  );

  const placed = useMemo(() => {
    if (!map) return [];
    const out: Placed[] = [];
    for (const group of review.groups) {
      const proposal = review.pending.find((p) => p.id === group.proposalId);
      if (!proposal) continue;
      const ids = group.ghostNodeIds.length > 0 ? group.ghostNodeIds : group.touchedNodeIds;
      // A ghost nested in another ghost is inside its rect already.
      const rects = ids
        .map((id) => absoluteRect(id, map))
        .filter((r): r is Rect => r !== undefined);
      const bounds = boundsOf(rects);
      if (!bounds) continue;
      const padded = {
        x: bounds.x - PAD,
        y: bounds.y - PAD,
        w: bounds.w + PAD * 2,
        h: bounds.h + PAD * 2,
      };
      out.push({
        group,
        proposal,
        rect: toScreen(padded, transform),
        outline: group.ghostNodeIds.length > 0,
      });
    }
    return out;
  }, [map, review, transform]);

  const spots = useMemo(
    () =>
      placeControls(
        placed.map((p) => p.rect),
        { w: width, h: height },
        CONTROL,
      ),
    [placed, width, height],
  );

  if (placed.length === 0 || width === 0) return null;
  return (
    <div className="proposal-layer">
      {future.map((f) => {
        const r = toScreen(f.next, transform);
        return (
          <div
            key={`future-${f.id}`}
            className={`future-outline${f.frame ? ' is-frame' : ''}`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            aria-hidden="true"
          />
        );
      })}
      {placed.map((p) =>
        p.outline ? (
          <div
            key={`outline-${p.proposal.id}`}
            className="proposal-outline"
            style={{ left: p.rect.x, top: p.rect.y, width: p.rect.w, height: p.rect.h }}
            aria-hidden="true"
          >
            <GroupLabel author={p.proposal.author} />
          </div>
        ) : null,
      )}
      {placed.map((p, i) => {
        const at = spots[i];
        if (!at) return null;
        return (
          <InlineDecision key={p.proposal.id} proposal={p.proposal} left={at.left} top={at.top} />
        );
      })}
    </div>
  );
}

function useActorName(id: string): string {
  const { store } = useSession();
  return useStoreValue(store, () => store.meta.actors[id]?.name ?? id);
}

function GroupLabel({ author }: { author: string }) {
  const name = useActorName(author);
  return <span className="proposal-outline-label">Proposed by {name}</span>;
}

const InlineDecision = memo(function InlineDecision({
  proposal,
  left,
  top,
}: {
  proposal: Proposal;
  left: number;
  top: number;
}) {
  const session = useSession();
  const author = useStoreValue(session.store, () => session.store.meta.actors[proposal.author]);
  const name = author?.name ?? proposal.author;
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = proposal.items.filter((item) => item.status === 'pending').length;
  const conflicts = proposal.items.filter((item) => item.status === 'conflict').length;

  const run = async (action: 'accept' | 'reject') => {
    setBusy(action);
    setError(null);
    const result = await decide(session, proposal, { action });
    setBusy(null);
    if (!result.ok) setError(result.message);
    else toasts.show(result.value.text, { tone: result.value.conflicts.length ? 'error' : 'info' });
  };

  return (
    <section
      className="inline-decision nodrag nopan nowheel"
      style={{ left, top, width: CONTROL.w }}
      aria-label={`Decide on the proposal by ${name}`}
    >
      <div className="inline-decision-head">
        {author && <Avatar actor={author} size={20} />}
        <p className="inline-decision-who">
          <strong>{name}</strong>{' '}
          <span className="muted">
            proposes {pending} change{pending === 1 ? '' : 's'}
          </span>
        </p>
        <time className="inline-decision-time" dateTime={proposal.createdAt}>
          {relativeTime(proposal.createdAt)}
        </time>
      </div>
      {proposal.reason && <p className="inline-decision-reason">{proposal.reason}</p>}
      {conflicts > 0 && (
        <p className="inline-decision-note">
          <Icon name="warning" size={12} />
          {conflicts} can no longer be applied
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="inline-decision-actions">
        <button
          type="button"
          className="pill pill-accept"
          disabled={busy !== null || pending === 0}
          onClick={() => void run('accept')}
        >
          {busy === 'accept' ? 'Accepting…' : 'Accept'}
        </button>
        <button
          type="button"
          className="pill pill-reject"
          disabled={busy !== null || pending === 0}
          onClick={() => void run('reject')}
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          type="button"
          className="pill pill-quiet"
          onClick={() => openReview(session, proposal.id)}
        >
          Review
        </button>
      </div>
    </section>
  );
});
