/**
 * Questions agents ask, as a calm stack at the top of the canvas. Never a
 * modal and never focused on its own: the oldest question is shown in full,
 * the rest as one-line rows. Folding the stack leaves a count in the top bar.
 */
import type { Ask } from '@openboard/core';
import { useReactFlow } from '@xyflow/react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { calmMessage } from '../lib/api.js';
import { answerPayload, askOptions } from '../lib/asks.js';
import { absoluteTime, relativeTime } from '../lib/time.js';
import { useSession } from '../state/context.js';
import { useStoreValue, useValue } from '../state/emitter.js';
import { Avatar } from '../ui/Avatar.js';
import { IconButton } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';
import { reducedMotion } from './actions.js';

const CONFIRM_MS = 2600;

interface Confirmation {
  key: number;
  text: string;
}

export function AskStack() {
  const session = useSession();
  const { store, ui } = session;
  const asks = useStoreValue(store, store.openAsks);
  const collapsed = useValue(ui.asksCollapsed);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const nextKey = useRef(1);
  const ref = useRef<HTMLElement>(null);

  // A new question unfolds the stack again; it never takes focus.
  const seen = useRef(asks.length);
  useEffect(() => {
    if (asks.length > seen.current) ui.asksCollapsed.set(false);
    seen.current = asks.length;
  }, [asks.length, ui]);

  // Other overlays at the top of the canvas move down by the stack's height.
  useLayoutEffect(() => {
    const el = ref.current;
    const root = el?.closest<HTMLElement>('.canvas-root');
    if (!root) return;
    const set = () => root.style.setProperty('--asks-h', `${el?.offsetHeight ?? 0}px`);
    set();
    if (typeof ResizeObserver === 'undefined' || !el)
      return () => root.style.removeProperty('--asks-h');
    const observer = new ResizeObserver(set);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--asks-h');
    };
  });

  const confirm = (text: string) => {
    const key = nextKey.current++;
    setConfirmations((list) => [...list.slice(-1), { key, text }]);
    setTimeout(() => setConfirmations((list) => list.filter((c) => c.key !== key)), CONFIRM_MS);
  };

  const shown = collapsed ? [] : asks;
  if (shown.length === 0 && confirmations.length === 0) return null;
  const active = shown.find((a) => a.id === expanded) ?? shown[0];
  const rest = shown.filter((a) => a !== active);

  return (
    <section ref={ref} className="ask-stack" aria-label="Questions from agents">
      <div role="status" aria-live="polite" className="ask-confirmations">
        {confirmations.map((c) => (
          <p key={c.key} className="ask-confirmation">
            <Icon name="check" size={14} />
            {c.text}
          </p>
        ))}
      </div>
      {active && <AskCard key={active.id} ask={active} onAnswered={confirm} />}
      {rest.length > 0 && (
        <ul className="ask-rows">
          {rest.map((ask) => (
            <li key={ask.id}>
              <AskRow ask={ask} onOpen={() => setExpanded(ask.id)} />
            </li>
          ))}
        </ul>
      )}
      {shown.length > 0 && (
        <button type="button" className="ask-fold" onClick={() => ui.asksCollapsed.set(true)}>
          Hide {shown.length === 1 ? 'question' : `${shown.length} questions`}
        </button>
      )}
    </section>
  );
}

function useAuthor(id: string) {
  const { store } = useSession();
  return useStoreValue(store, () => store.meta.actors[id]);
}

function AskRow({ ask, onOpen }: { ask: Ask; onOpen: () => void }) {
  const author = useAuthor(ask.author);
  return (
    <button type="button" className="ask-row" onClick={onOpen}>
      {author && <Avatar actor={author} size={18} />}
      <span className="ask-row-name">{author?.name ?? ask.author}</span>
      <span className="ask-row-question">{ask.question}</span>
    </button>
  );
}

export function AskCard({ ask, onAnswered }: { ask: Ask; onAnswered?: (text: string) => void }) {
  const session = useSession();
  const { ui } = session;
  const author = useAuthor(ask.author);
  const name = author?.name ?? ask.author;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flow = useReactFlow();
  const fieldId = useId();
  const options = askOptions(ask);
  const nodeIds = ask.nodeIds ?? [];

  const send = async (option?: string) => {
    const payload = answerPayload(option, text);
    if (!payload || busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.api.answerAsk(session.boardId, ask.id, payload);
      onAnswered?.(`Answer sent to ${name}`);
    } catch (err) {
      setError(calmMessage(err, 'question'));
      setBusy(false);
    }
  };

  const withdraw = () => {
    ui.confirm.set({
      title: 'Dismiss this question?',
      body: `${name} will be told the question was withdrawn without an answer.`,
      actions: [
        { label: 'Keep it', run: () => {} },
        {
          label: 'Dismiss question',
          tone: 'danger',
          run: () => {
            void session.api
              .cancelAsk(session.boardId, ask.id)
              .then(() => onAnswered?.('Question dismissed'))
              .catch((err: unknown) => setError(calmMessage(err, 'question')));
          },
        },
      ],
    });
  };

  const point = () => {
    const known = nodeIds.filter((id) => flow.getNode(id));
    if (known.length === 0) return;
    ui.pauseFollow();
    void flow.fitView({
      nodes: known.map((id) => ({ id })),
      duration: reducedMotion() ? 0 : 280,
      padding: 0.4,
      maxZoom: 1.1,
    });
  };

  useEffect(() => () => ui.pointAt([]), [ui]);

  return (
    <article className={`ask-card kind-${ask.kind}`} aria-label={`Question from ${name}`}>
      <header className="ask-card-head">
        {author && <Avatar actor={author} size={22} />}
        <p className="ask-card-who">
          <strong>{name}</strong>{' '}
          <span className="muted">
            {ask.kind === 'approval' ? 'asks for your approval' : 'asks'}
          </span>
        </p>
        <time dateTime={ask.createdAt} title={absoluteTime(ask.createdAt)}>
          {relativeTime(ask.createdAt)}
        </time>
        <IconButton icon="close" label="Dismiss question" size="sm" onClick={withdraw} />
      </header>
      <p className="ask-question">{ask.question}</p>
      {options.length > 0 && (
        <div className="ask-options">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`pill ${option.primary ? 'pill-accept' : 'pill-reject'}`}
              disabled={busy}
              onClick={() => void send(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      <form
        className="ask-answer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor={fieldId} className="visually-hidden">
          {options.length > 0
            ? 'Answer in your own words (sent with an option, or alone)'
            : 'Answer'}
        </label>
        <input
          id={fieldId}
          className="input input-sm"
          placeholder="Answer…"
          maxLength={2000}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="pill pill-quiet" disabled={busy || text.trim() === ''}>
          Send
        </button>
        {nodeIds.length > 0 && (
          <button
            type="button"
            className="pill pill-quiet"
            onClick={point}
            onPointerEnter={() => ui.pointAt(nodeIds)}
            onPointerLeave={() => ui.pointAt([])}
            onFocus={() => ui.pointAt(nodeIds)}
            onBlur={() => ui.pointAt([])}
          >
            <Icon name="locate" size={13} />
            Point
          </button>
        )}
      </form>
      {options.length > 0 && text.trim() !== '' && (
        <p className="ask-hint">Your text goes along with the option you pick.</p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/** The top-bar count while the stack is folded away. */
export function AskIndicator() {
  const { store, ui } = useSession();
  const count = useStoreValue(store, () => store.openAsks().length);
  const collapsed = useValue(ui.asksCollapsed);
  if (count === 0 || !collapsed) return null;
  const label = `${count} question${count === 1 ? '' : 's'} from agents`;
  return (
    <button
      type="button"
      className="icon-btn icon-btn-md panel-toggle"
      aria-label={`${label}. Show`}
      title={label}
      onClick={() => ui.asksCollapsed.set(false)}
    >
      <Icon name="ask" />
      <span className="panel-badge">{count}</span>
    </button>
  );
}
