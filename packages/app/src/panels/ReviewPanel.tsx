/**
 * The review panel: every pending proposal, newest first, item by item.
 * Dependencies hold while choosing (checking an item checks what it needs,
 * unchecking one unchecks what needs it), conflicts cannot be accepted, and
 * the person can leave a note the agent will read.
 *
 * Keys while the panel has focus: A accepts the selected items of the
 * proposal in focus, R rejects them, arrow keys move between items, Space
 * toggles one.
 */
import { type Proposal, type ProposalItem, selectItems } from '@openboard/core';
import { useReactFlow } from '@xyflow/react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { reducedMotion } from '../canvas/actions.js';
import {
  affectedNodes,
  type DecisionOutcome,
  initialSelection,
  selectable,
  toggleItem,
} from '../lib/review.js';
import { absoluteTime, relativeTime } from '../lib/time.js';
import { useSession } from '../state/context.js';
import { useStoreValue, useValue } from '../state/emitter.js';
import { decide } from '../state/review.js';
import type { BoardSession } from '../state/session.js';
import { Avatar } from '../ui/Avatar.js';
import { Button } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';

const OUTCOME_MS = 9000;
const DECIDED_SHOWN = 6;

interface Outcome extends DecisionOutcome {
  key: number;
  author: string;
}

type CardActions = { accept(): void; reject(): void };

export function ReviewPanel() {
  const session = useSession();
  const { store } = session;
  const review = useStoreValue(store, store.review);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const actions = useRef(new Map<string, CardActions>());
  const nextKey = useRef(1);

  const onDecided = useCallback((proposal: Proposal, outcome: DecisionOutcome) => {
    const key = nextKey.current++;
    setOutcomes((list) => [...list.slice(-2), { ...outcome, key, author: proposal.author }]);
    setTimeout(() => setOutcomes((list) => list.filter((o) => o.key !== key)), OUTCOME_MS);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('textarea, input[type="text"], input:not([type])')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-review-item]')];
      if (items.length === 0) return;
      const index = items.findIndex((el) => el === target || el.contains(target));
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = items[index < 0 ? 0 : Math.max(0, Math.min(items.length - 1, index + step))];
      event.preventDefault();
      next?.focus();
      return;
    }
    const key = event.key.toLowerCase();
    if (key !== 'a' && key !== 'r') return;
    const id =
      target.closest<HTMLElement>('[data-proposal]')?.dataset.proposal ?? review.pending[0]?.id;
    const card = id ? actions.current.get(id) : undefined;
    if (!card) return;
    event.preventDefault();
    if (key === 'a') card.accept();
    else card.reject();
  };

  return (
    // The panel is a keyboard region: it takes A, R and the arrow keys.
    <div className="review-panel" onKeyDown={onKeyDown}>
      <div className="review-outcomes" role="status" aria-live="polite">
        {outcomes.map((o) => (
          <OutcomeNote key={o.key} outcome={o} />
        ))}
      </div>
      {review.pending.length === 0 ? (
        <div className="panel-empty">
          <Icon name="review" size={20} />
          <p>
            Nothing to review. When an agent changes something that needs your say, it waits here
            until you accept or reject it.
          </p>
        </div>
      ) : (
        <>
          <p className="panel-intro">
            {review.pending.length === 1
              ? '1 proposal waits for you.'
              : `${review.pending.length} proposals wait for you.`}{' '}
            <span className="muted">
              <kbd className="kbd">A</kbd> accept, <kbd className="kbd">R</kbd> reject the selected
              items.
            </span>
          </p>
          {review.pending.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              register={(a) => {
                if (a) actions.current.set(proposal.id, a);
                else actions.current.delete(proposal.id);
              }}
              onDecided={onDecided}
            />
          ))}
        </>
      )}
      {review.decided.length > 0 && <RecentlyDecided proposals={review.decided} />}
    </div>
  );
}

function OutcomeNote({ outcome }: { outcome: Outcome }) {
  return (
    <div className={`outcome${outcome.conflicts.length ? ' has-conflicts' : ''}`}>
      <Icon name={outcome.conflicts.length ? 'warning' : 'check'} size={14} />
      <div>
        <p>{outcome.text}</p>
        {outcome.conflicts.length > 0 && (
          <ul className="outcome-conflicts">
            {outcome.conflicts.map((c) => (
              <li key={c.summary}>
                {c.summary}: <span className="muted">{c.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function usePan(session: BoardSession) {
  const flow = useReactFlow();
  return useCallback(
    (ids: readonly string[]) => {
      const known = ids.filter((id) => flow.getNode(id));
      if (known.length === 0) return;
      session.ui.pauseFollow();
      void flow.fitView({
        nodes: known.map((id) => ({ id })),
        duration: reducedMotion() ? 0 : 280,
        padding: 0.35,
        maxZoom: 1.1,
      });
    },
    [flow, session],
  );
}

/** Keep the selection in step with items whose status changed (accepted, now a conflict). */
function useItemSelection(proposal: Proposal) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => initialSelection(proposal));
  const known = useRef(new Map(proposal.items.map((i) => [i.index, i.status])));
  useEffect(() => {
    const previous = known.current;
    known.current = new Map(proposal.items.map((i) => [i.index, i.status]));
    setSelected((current) => {
      const next = new Set<number>();
      for (const item of proposal.items) {
        if (!selectable(item)) continue;
        // Newly pending items start checked; the rest keep the person's choice.
        if (current.has(item.index) || previous.get(item.index) !== 'pending') next.add(item.index);
      }
      return next.size === current.size && [...next].every((i) => current.has(i)) ? current : next;
    });
  }, [proposal.items]);
  return [selected, setSelected] as const;
}

const STATUS_LABEL: Record<ProposalItem['status'], string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  conflict: 'Conflict',
};

export function ProposalCard({
  proposal,
  register,
  onDecided,
}: {
  proposal: Proposal;
  register?: (actions: CardActions | null) => void;
  onDecided?: (proposal: Proposal, outcome: DecisionOutcome) => void;
}) {
  const session = useSession();
  const { store, ui } = session;
  const author = useStoreValue(store, () => store.meta.actors[proposal.author]);
  const name = author?.name ?? proposal.author;
  const [selected, setSelected] = useItemSelection(proposal);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focus = useValue(ui.focusProposal);
  const ref = useRef<HTMLElement>(null);
  const noteId = useId();
  const pan = usePan(session);

  const pending = proposal.items.filter(selectable);
  const chosen = pending.filter((item) => selected.has(item.index)).map((item) => item.index);
  const lookup = useMemo(
    () => ({ node: (id: string) => store.node(id), edge: (id: string) => store.edge(id) }),
    [store],
  );
  const alsoRejected =
    chosen.length > 0
      ? selectItems(proposal, { action: 'reject', items: chosen }).reject.length - chosen.length
      : 0;

  const run = useCallback(
    async (action: 'accept' | 'reject', items?: number[]) => {
      if (busy) return;
      if (items && items.length === 0) return;
      setBusy(true);
      setError(null);
      const decision: Parameters<typeof decide>[2] = { action };
      if (items && items.length < pending.length) decision.items = items;
      const clean = note.trim();
      if (clean) decision.note = clean.slice(0, 1000);
      const result = await decide(session, proposal, decision);
      setBusy(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNote('');
      setNoteOpen(false);
      onDecided?.(proposal, result.value);
    },
    [busy, note, onDecided, pending.length, proposal, session],
  );

  useEffect(() => {
    register?.({
      accept: () => void run('accept', chosen),
      reject: () => void run('reject', chosen),
    });
    return () => register?.(null);
  });

  useEffect(() => {
    if (focus?.id === proposal.id)
      ref.current?.scrollIntoView({
        block: 'nearest',
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
  }, [focus, proposal.id]);

  const isFocused = focus?.id === proposal.id;

  return (
    <section
      ref={ref}
      className={`proposal-card${isFocused ? ' is-focused' : ''}`}
      data-proposal={proposal.id}
      aria-label={`Proposal by ${name}`}
      onPointerLeave={() => ui.pointAt([])}
    >
      <header className="proposal-card-head">
        {author && <Avatar actor={author} size={24} />}
        <div className="proposal-card-who">
          <p>
            <strong>{name}</strong>
            {author?.kind === 'agent' && <span className="kind-mark">agent</span>}
          </p>
          <time dateTime={proposal.createdAt} title={absoluteTime(proposal.createdAt)}>
            {relativeTime(proposal.createdAt)}
          </time>
        </div>
      </header>
      {proposal.reason && <p className="proposal-reason">{proposal.reason}</p>}

      <ul className="review-items" aria-label="Changes">
        {proposal.items.map((item) => {
          const ids = affectedNodes(item, proposal, lookup);
          const canChoose = selectable(item);
          return (
            <li
              key={item.index}
              className={`review-item status-${item.status}${item.needsReview ? '' : ' is-quiet'}`}
              onPointerEnter={() => ui.pointAt(ids)}
            >
              {canChoose ? (
                <input
                  type="checkbox"
                  data-review-item=""
                  checked={selected.has(item.index)}
                  aria-label={item.summary}
                  onFocus={() => ui.pointAt(ids)}
                  onBlur={() => ui.pointAt([])}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      pan(ids);
                    }
                  }}
                  onChange={(event) =>
                    setSelected(
                      toggleItem(proposal.items, selected, item.index, event.target.checked),
                    )
                  }
                />
              ) : (
                <span
                  className={`item-status status-${item.status}`}
                  title={STATUS_LABEL[item.status]}
                >
                  <Icon
                    name={
                      item.status === 'accepted'
                        ? 'check'
                        : item.status === 'conflict'
                          ? 'warning'
                          : 'close'
                    }
                    size={12}
                  />
                  <span className="visually-hidden">{STATUS_LABEL[item.status]}</span>
                </span>
              )}
              <div className="review-item-text">
                <button
                  type="button"
                  className="review-item-summary"
                  title={ids.length ? 'Show on the canvas' : undefined}
                  onClick={() => pan(ids)}
                  tabIndex={canChoose ? -1 : 0}
                  data-review-item={canChoose ? undefined : ''}
                >
                  {item.summary}
                </button>
                {!item.needsReview && canChoose && (
                  <span className="review-item-hint">Comes with the changes above</span>
                )}
                {item.status === 'conflict' && (
                  <span className="review-item-conflict">
                    Can’t be accepted: {item.conflict ?? 'the board changed'}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {noteOpen ? (
        <div className="field proposal-note">
          <label className="field-label" htmlFor={noteId}>
            Note for {name}
          </label>
          <textarea
            id={noteId}
            className="input"
            rows={2}
            maxLength={1000}
            value={note}
            placeholder="Why, or what to do instead"
            onChange={(event) => setNote(event.target.value)}
          />
          <p className="field-hint">{name} will see this note with your decision.</p>
        </div>
      ) : (
        <button
          type="button"
          className="link-btn proposal-note-toggle"
          onClick={() => setNoteOpen(true)}
        >
          Add a note for {name}
        </button>
      )}

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}

      <div className="proposal-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || chosen.length === 0}
          onClick={() => void run('accept', chosen)}
        >
          Accept selected ({chosen.length})
        </Button>
        <Button
          size="sm"
          disabled={busy || chosen.length === 0}
          onClick={() => void run('reject', chosen)}
        >
          Reject selected
        </Button>
      </div>
      <div className="proposal-actions proposal-actions-all">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || pending.length === 0}
          onClick={() => void run('accept')}
        >
          Accept all
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || pending.length === 0}
          onClick={() => void run('reject')}
        >
          Reject all
        </Button>
        {alsoRejected > 0 && (
          <span className="proposal-actions-hint">
            Rejecting also rejects {alsoRejected} item{alsoRejected === 1 ? '' : 's'} that need
            {alsoRejected === 1 ? 's' : ''} these.
          </span>
        )}
      </div>
    </section>
  );
}

const DECIDED_LABEL: Record<Proposal['status'], string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  partly_accepted: 'Partly accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

function RecentlyDecided({ proposals }: { proposals: readonly Proposal[] }) {
  const { store } = useSession();
  const actors = useStoreValue(store, () => store.meta.actors);
  const shown = proposals.slice(0, DECIDED_SHOWN);
  return (
    <details className="recently-decided">
      <summary>Recently decided ({shown.length})</summary>
      <ul>
        {shown.map((p) => {
          const at = p.decidedAt ?? p.createdAt;
          return (
            <li key={p.id}>
              <span className={`decided-status decided-${p.status}`}>
                {DECIDED_LABEL[p.status]}
              </span>
              <span className="decided-text">
                {actors[p.author]?.name ?? p.author}
                {p.reason ? `: ${p.reason}` : ''}
              </span>
              <time dateTime={at} title={absoluteTime(at)}>
                {relativeTime(at)}
              </time>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
