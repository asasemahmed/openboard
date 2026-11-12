/**
 * Decorations for working with agents: what a pending proposal would do to a
 * card, open comment threads, questions that point at a card, a frame's agent
 * access, and the outline a panel draws when it points at something.
 * Registered once at startup, next to the built-in ones.
 */
import type { Proposal } from '@openboard/core';
import { type RefObject, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FRAME_ACCESS_META, frameAccess } from '../lib/policy.js';
import { fieldChanges, fieldName, type MarkKind } from '../lib/review.js';
import { actorName } from '../state/activity.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { openReview } from '../state/review.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { type DecorationProps, registerNodeDecoration } from './decorations.js';

const MARK_LABEL: Record<MarkKind, { short: string; long: string; icon: IconName }> = {
  update: { short: 'Edit proposed', long: 'A change to this card is proposed', icon: 'edit' },
  remove: { short: 'Removal proposed', long: 'Removing this card is proposed', icon: 'trash' },
  conflict: {
    short: 'Conflict',
    long: 'A proposed change to this card can no longer be applied',
    icon: 'warning',
  },
};

/** "Edit proposed" or "Removal proposed" on a card, with before -> after on hover or focus. */
function ProposalMark({ node }: DecorationProps) {
  const session = useSession();
  const { store } = session;
  const mark = useStoreValue(store, () => store.review().nodeMarks.get(node.id));
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!mark) return null;
  const meta = MARK_LABEL[mark.kind];
  const proposalId = mark.proposalIds[0];
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`proposal-mark nodrag mark-${mark.kind}`}
        aria-label={`${meta.long}. Review it`}
        aria-describedby={open ? `proposal-card-${node.id}` : undefined}
        onClick={(event) => {
          event.stopPropagation();
          openReview(session, proposalId);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Icon name={meta.icon} size={12} />
        <span>{meta.short}</span>
      </button>
      {open && (
        <MarkCard
          anchor={anchor}
          nodeId={node.id}
          proposalIds={mark.proposalIds}
          kind={mark.kind}
          reason={mark.reason}
        />
      )}
    </>
  );
}

/** The hover card: who proposes what, field by field. Drawn in a portal so the card does not clip it. */
function MarkCard({
  anchor,
  nodeId,
  proposalIds,
  kind,
  reason,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  nodeId: string;
  proposalIds: readonly string[];
  kind: MarkKind;
  reason: string | undefined;
}) {
  const { store, doc } = useSession();
  const rect = anchor.current?.getBoundingClientRect();
  const node = store.node(nodeId);
  if (!rect || !node) return null;
  const proposals = proposalIds
    .map((id) => doc.getProposal(id))
    .filter((p): p is Proposal => p !== undefined);
  const titleOf = (id: string) => store.node(id)?.title ?? id;
  const top = Math.min(rect.bottom + 6, window.innerHeight - 160);
  const left = Math.max(8, Math.min(rect.left - 40, window.innerWidth - 300));
  return createPortal(
    <div id={`proposal-card-${nodeId}`} role="tooltip" className="mark-card" style={{ top, left }}>
      {proposals.map((proposal) => {
        const name = actorName(store.meta.actors, proposal.author) ?? proposal.author;
        const changes = kind === 'update' ? fieldChanges(node, proposal, titleOf) : [];
        return (
          <div key={proposal.id} className="mark-card-proposal">
            <p className="mark-card-head">
              {kind === 'remove'
                ? `${name} proposes removing this card`
                : kind === 'conflict'
                  ? `${name}’s change can no longer be applied`
                  : `${name} proposes`}
            </p>
            {changes.length > 0 && (
              <dl className="diff-list">
                {changes.map((change) => (
                  <div key={change.field} className="diff-row">
                    <dt>{fieldName(change.field)}</dt>
                    <dd>
                      <span className="diff-before">{change.before}</span>
                      <Icon name="arrowRight" size={12} />
                      <span className="diff-after">{change.after}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {kind === 'conflict' && reason && <p className="mark-card-note">{reason}</p>}
          </div>
        );
      })}
      <p className="mark-card-hint">Click to review</p>
    </div>,
    document.body,
  );
}

/** Open comment threads on a card, as a count. */
function CommentCount({ node }: DecorationProps) {
  const { store, ui } = useSession();
  const count = useStoreValue(store, () => store.comments().openByNode.get(node.id) ?? 0);
  if (count === 0) return null;
  const label = `${count} open comment thread${count === 1 ? '' : 's'}. Show comments`;
  return (
    <button
      type="button"
      className="comment-count nodrag"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        store.select([node.id]);
        ui.showRightPanel('inspector');
        requestAnimationFrame(() =>
          document.getElementById(`comments-${node.id}`)?.scrollIntoView({ block: 'nearest' }),
        );
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icon name="comment" size={12} />
      {count}
    </button>
  );
}

/** A quiet marker while an agent's open question points at this card. */
function AskMarker({ node }: DecorationProps) {
  const { store } = useSession();
  const asked = useStoreValue(store, () => (store.asksOn(node.id)?.length ?? 0) > 0);
  if (!asked) return null;
  return (
    <div className="ask-outline" aria-hidden="true">
      <span className="ask-tag">
        <Icon name="ask" size={11} />
        Asked about
      </span>
    </div>
  );
}

const ACCESS_ICON = { auto: 'unlock', review: 'eye', locked: 'lock' } as const;

/** A frame that overrides agent access shows it in its title bar. */
function FramePolicyBadge({ node }: DecorationProps) {
  const access = frameAccess(node);
  if (access === 'inherit') return null;
  const meta = FRAME_ACCESS_META[access];
  const label = `Agent access: ${meta.name}. ${meta.line}`;
  return (
    <span className={`frame-policy policy-${access}`} role="img" aria-label={label} title={label}>
      <Icon name={ACCESS_ICON[access]} size={13} />
    </span>
  );
}

/** The outline a panel draws while it points at this node (a hovered review item, a history row). */
function PanelPointer({ node }: DecorationProps) {
  const { ui } = useSession();
  const on = useStoreValue(ui.highlight, () => ui.highlight.get().includes(node.id));
  if (!on) return null;
  return <div className="pointer-outline" aria-hidden="true" />;
}

/** "Proposed" in a ghost's label row. */
function GhostTag({ node }: DecorationProps) {
  const { store } = useSession();
  const owned = useStoreValue(store, () => store.review().ghostOwner.has(node.id));
  if (!owned) return null;
  return <span className="ghost-tag">proposed</span>;
}

let registered = false;

export function registerTrustDecorations(): void {
  if (registered) return;
  registered = true;
  registerNodeDecoration({
    id: 'proposal-mark',
    slot: 'header',
    order: 10,
    applies: (_node, ghost) => !ghost,
    Component: ProposalMark,
  });
  registerNodeDecoration({
    id: 'ghost-tag',
    slot: 'header',
    order: 10,
    applies: (_node, ghost) => ghost,
    Component: GhostTag,
  });
  registerNodeDecoration({
    id: 'frame-policy',
    slot: 'header',
    order: 20,
    applies: (node, ghost) => !ghost && node.type === 'frame',
    Component: FramePolicyBadge,
  });
  registerNodeDecoration({
    id: 'comment-count',
    slot: 'header',
    order: 30,
    applies: (_node, ghost) => !ghost,
    Component: CommentCount,
  });
  registerNodeDecoration({
    id: 'ask-marker',
    slot: 'overlay',
    order: 5,
    applies: (_node, ghost) => !ghost,
    Component: AskMarker,
  });
  registerNodeDecoration({
    id: 'panel-pointer',
    slot: 'overlay',
    order: 1,
    Component: PanelPointer,
  });
}
