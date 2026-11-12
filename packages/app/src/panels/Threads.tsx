/**
 * Comment threads and the composer, shared by the inspector (threads on the
 * selected card) and the comments panel (every thread on the board).
 *
 * Comments are written straight into the board document as this person, so
 * they work while the server is unreachable and sync when it is back.
 */
import type { Comment } from '@openboard/core';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { newComment, type Thread, withResolved } from '../lib/comments.js';
import {
  ALL_AGENTS,
  insertMention,
  type MentionTarget,
  matchTargets,
  mentionQuery,
  mentionsIn,
} from '../lib/mentions.js';
import { IS_MAC } from '../lib/shortcuts.js';
import { absoluteTime, relativeTime } from '../lib/time.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import type { BoardSession } from '../state/session.js';
import { toasts } from '../state/toasts.js';
import { Avatar } from '../ui/Avatar.js';
import { Button, IconButton } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';
import { Markdown } from '../ui/Markdown.js';

const SEND_KEYS = IS_MAC ? '⌘ Enter' : 'Ctrl Enter';

function write(session: BoardSession, comment: Comment): boolean {
  try {
    const actor = session.actor();
    session.doc.putComment(comment, session.doc.origin(actor.id, 'ui'), { actor });
    return true;
  } catch (error) {
    toasts.show(error instanceof Error ? error.message : 'The comment could not be saved.', {
      tone: 'error',
    });
    return false;
  }
}

/** Start a thread (on a node or the board) or reply in one. */
export function postComment(
  session: BoardSession,
  body: string,
  mentions: readonly string[],
  where: { thread?: Thread; nodeId?: string },
): boolean {
  if (body.trim() === '') return false;
  const input: Parameters<typeof newComment>[0] = { author: session.actor(), body, mentions };
  if (where.thread) input.thread = where.thread;
  if (where.nodeId) input.nodeId = where.nodeId;
  return write(session, newComment(input));
}

/** People and agents on this board that can be mentioned, plus "All agents". */
function useMentionTargets(): MentionTarget[] {
  const session = useSession();
  const actors = useStoreValue(session.store, () => session.store.meta.actors);
  return useMemo(() => {
    const me = session.actor().id;
    const people = Object.values(actors)
      .filter((a) => a.id !== me && a.kind !== 'system')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({ id: a.id, label: a.name }));
    return [ALL_AGENTS, ...people];
  }, [actors, session]);
}

export function Composer({
  onSubmit,
  placeholder = 'Write a comment',
  label,
  submitLabel = 'Comment',
  onCancel,
}: {
  onSubmit: (body: string, mentions: string[]) => boolean;
  placeholder?: string;
  label: string;
  submitLabel?: string;
  onCancel?: () => void;
}) {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<MentionTarget[]>([]);
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const targets = useMentionTargets();
  const id = useId();
  const listId = `${id}-mentions`;
  const matches = query ? matchTargets(targets, query.query).slice(0, 8) : [];
  const picking = query !== null && matches.length > 0;

  const track = (value: string, caret: number) => {
    const next = mentionQuery(value, caret);
    setQuery(next);
    if (next?.query !== query?.query) setActive(0);
  };

  const pick = (target: MentionTarget) => {
    const el = ref.current;
    if (!el || !query) return;
    const caret = el.selectionStart ?? text.length;
    const next = insertMention(text, query.start, caret, target.label);
    setText(next.text);
    setPicked((list) => (list.some((t) => t.id === target.id) ? list : [...list, target]));
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = () => {
    if (text.trim() === '') return;
    if (onSubmit(text, mentionsIn(text, picked))) {
      setText('');
      setPicked([]);
      setQuery(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picking) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const target = matches[active];
        if (target) {
          event.preventDefault();
          pick(target);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setQuery(null);
        return;
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="composer">
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        className="input composer-input"
        rows={2}
        maxLength={4000}
        value={text}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={picking}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={picking ? `${listId}-${active}` : undefined}
        onChange={(event) => {
          setText(event.target.value);
          track(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={(event) =>
          track(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)
        }
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        onKeyDown={onKeyDown}
      />
      {picking && (
        <ul className="mention-list" role="listbox" id={listId} aria-label="Mention">
          {matches.map((target, i) => (
            <li
              key={target.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : ''}
              onPointerDown={(event) => {
                event.preventDefault();
                pick(target);
              }}
            >
              {target === ALL_AGENTS ? (
                <Icon name="agent" size={13} />
              ) : (
                <span className="mention-at">@</span>
              )}
              {target.label}
            </li>
          ))}
        </ul>
      )}
      <div className="composer-foot">
        <span className="composer-hint">
          <kbd className="kbd">@</kbd> to mention, <kbd className="kbd">{SEND_KEYS}</kbd> to send
        </span>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={text.trim() === ''} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function CommentView({ comment, onDelete }: { comment: Comment; onDelete?: () => void }) {
  const { store } = useSession();
  const author = useStoreValue(store, () => store.meta.actors[comment.author]);
  const name = author?.name ?? comment.author;
  return (
    <li className="comment">
      {author ? <Avatar actor={author} size={22} /> : <span className="avatar-blank" />}
      <div className="comment-main">
        <div className="comment-meta">
          <strong>{name}</strong>
          {author?.kind === 'agent' && (
            <span className="author-mark" role="img" aria-label="agent" title="Agent">
              <Icon name="agent" size={13} />
            </span>
          )}
          <time dateTime={comment.createdAt} title={absoluteTime(comment.createdAt)}>
            {relativeTime(comment.createdAt)}
          </time>
          {onDelete && (
            <IconButton
              icon="trash"
              label="Delete your comment"
              size="sm"
              className="comment-delete"
              onClick={onDelete}
            />
          )}
        </div>
        <Markdown source={comment.body} className="markdown comment-body" />
      </div>
    </li>
  );
}

export function ThreadView({ thread, context }: { thread: Thread; context?: ReactNode }) {
  const session = useSession();
  const { ui } = session;
  const me = session.actor().id;
  const [replying, setReplying] = useState(false);

  const resolve = useCallback(
    (resolved: boolean) => {
      const head = session.doc.getComment(thread.id);
      if (!head) return;
      write(session, withResolved(head, resolved, session.actor().id));
    },
    [session, thread.id],
  );

  const remove = (comment: Comment) =>
    ui.confirm.set({
      title: 'Delete your comment?',
      body: 'It is removed for everyone. Replies stay in the thread.',
      actions: [
        { label: 'Keep it', run: () => {} },
        {
          label: 'Delete comment',
          tone: 'danger',
          run: () => {
            const actor = session.actor();
            session.doc.deleteComment(comment.id, session.doc.origin(actor.id, 'ui'));
          },
        },
      ],
    });

  return (
    <article className={`thread${thread.resolved ? ' is-resolved' : ''}`}>
      {context}
      <ol className="thread-comments">
        {thread.comments.map((comment) => (
          <CommentView
            key={comment.id}
            comment={comment}
            {...(comment.author === me ? { onDelete: () => remove(comment) } : {})}
          />
        ))}
      </ol>
      {replying ? (
        <Composer
          label="Reply"
          placeholder="Reply"
          submitLabel="Reply"
          onCancel={() => setReplying(false)}
          onSubmit={(body, mentions) => {
            const ok = postComment(session, body, mentions, { thread });
            if (ok) setReplying(false);
            return ok;
          }}
        />
      ) : (
        <div className="thread-actions">
          <Button size="sm" variant="ghost" icon="comment" onClick={() => setReplying(true)}>
            Reply
          </Button>
          {thread.head.id === thread.id && (
            <Button
              size="sm"
              variant="ghost"
              icon={thread.resolved ? 'refresh' : 'check'}
              onClick={() => resolve(!thread.resolved)}
            >
              {thread.resolved ? 'Reopen' : 'Resolve'}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

/** The comments section of a card's inspector. */
export function NodeComments({ nodeId }: { nodeId: string }) {
  const session = useSession();
  const threads = useStoreValue(session.store, () => session.store.comments().byNode.get(nodeId));
  const open = (threads ?? []).filter((t) => !t.resolved);
  const resolved = (threads ?? []).filter((t) => t.resolved);
  return (
    <div className="node-comments" id={`comments-${nodeId}`}>
      {open.length === 0 && resolved.length === 0 && (
        <p className="muted small">
          Ask a question or leave feedback here. Mention an agent with @ to reach it.
        </p>
      )}
      {open.map((thread) => (
        <ThreadView key={thread.id} thread={thread} />
      ))}
      <Composer
        label="New comment on this card"
        placeholder="Comment on this card"
        onSubmit={(body, mentions) => postComment(session, body, mentions, { nodeId })}
      />
      {resolved.length > 0 && (
        <details className="resolved-threads">
          <summary>
            {resolved.length} resolved thread{resolved.length === 1 ? '' : 's'}
          </summary>
          {resolved.map((thread) => (
            <ThreadView key={thread.id} thread={thread} />
          ))}
        </details>
      )}
    </div>
  );
}
