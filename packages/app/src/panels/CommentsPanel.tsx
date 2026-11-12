/**
 * Every comment thread on the board: on cards, on cards that were removed,
 * and on the board itself. Clicking a card's name pans to it.
 */
import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import { reducedMotion } from '../canvas/actions.js';
import { filterThreads, type Thread, type ThreadFilter } from '../lib/comments.js';
import { useCan } from '../state/access.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { Icon } from '../ui/Icon.js';
import { Composer, postComment, ThreadView } from './Threads.js';

const FILTERS: Array<{ id: ThreadFilter; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'mine', label: 'Mine' },
];

function ThreadContext({ thread }: { thread: Thread }) {
  const { store } = useSession();
  const flow = useReactFlow();
  const title = useStoreValue(store, () =>
    thread.nodeId === undefined ? undefined : (store.node(thread.nodeId)?.title ?? null),
  );
  if (thread.nodeId === undefined) return <p className="thread-context">On the board</p>;
  if (title === null) return <p className="thread-context">On a card that was removed</p>;
  const nodeId = thread.nodeId;
  return (
    <button
      type="button"
      className="thread-context thread-context-link"
      onClick={() => {
        store.select([nodeId]);
        void flow.fitView({
          nodes: [{ id: nodeId }],
          duration: reducedMotion() ? 0 : 260,
          padding: 0.4,
          maxZoom: 1.1,
        });
      }}
    >
      <Icon name="locate" size={12} />
      {title}
    </button>
  );
}

export function CommentsPanel() {
  const session = useSession();
  const index = useStoreValue(session.store, session.store.comments);
  const [filter, setFilter] = useState<ThreadFilter>('open');
  const canComment = useCan('comment');
  const threads = filterThreads(index.threads, filter, session.actor().id);

  return (
    <div className="comments-panel">
      <div className="panel-toolbar">
        <div className="segmented" role="group" aria-label="Show threads">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              className={filter === f.id ? 'is-active' : ''}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {canComment && (
        <div className="comments-new">
          <Composer
            label="New comment on the board"
            placeholder="Comment on the whole board"
            onSubmit={(body, mentions) => postComment(session, body, mentions, {})}
          />
        </div>
      )}
      {index.threads.length === 0 ? (
        <div className="panel-empty">
          <Icon name="comment" size={20} />
          <p>
            No comments yet. Discuss a card from its inspector, or the whole board here; mention an
            agent with @ and it reads your comment next time it checks in.
          </p>
        </div>
      ) : threads.length === 0 ? (
        <p className="panel-note muted">
          {filter === 'open'
            ? 'Every thread is resolved.'
            : filter === 'resolved'
              ? 'No resolved threads yet.'
              : 'No threads you wrote in or were mentioned in.'}
        </p>
      ) : (
        <div className="thread-list">
          {threads.map((thread) => (
            <ThreadView
              key={thread.id}
              thread={thread}
              context={<ThreadContext thread={thread} />}
            />
          ))}
        </div>
      )}
    </div>
  );
}
