/** Comments grouped into threads, and the comment a person writes in the browser. */
import { type Actor, type Comment, newId } from '@openboard/core';

export interface Thread {
  /** The thread id: the id of its first comment. */
  id: string;
  /** The first comment, or the oldest left if the first was deleted. */
  head: Comment;
  /** Every comment, oldest first, the head included. */
  comments: readonly Comment[];
  nodeId: string | undefined;
  resolved: boolean;
  /** When the newest comment was written. */
  lastAt: string;
}

export interface CommentIndex {
  /** Newest activity first. */
  threads: readonly Thread[];
  byNode: ReadonlyMap<string, readonly Thread[]>;
  /** Unresolved threads per node. */
  openByNode: ReadonlyMap<string, number>;
  /** Unresolved threads on the whole board. */
  open: number;
}

export const EMPTY_COMMENTS: CommentIndex = Object.freeze({
  threads: [],
  byNode: new Map(),
  openByNode: new Map(),
  open: 0,
});

export function indexComments(comments: readonly Comment[]): CommentIndex {
  if (comments.length === 0) return EMPTY_COMMENTS;
  const groups = new Map<string, Comment[]>();
  for (const comment of comments) {
    const list = groups.get(comment.thread);
    if (list) list.push(comment);
    else groups.set(comment.thread, [comment]);
  }
  const threads: Thread[] = [];
  for (const [id, list] of groups) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const head = list.find((c) => c.id === id) ?? (list[0] as Comment);
    threads.push({
      id,
      head,
      comments: list,
      nodeId: head.nodeId,
      resolved: head.id === id && head.resolvedAt !== undefined,
      lastAt: (list[list.length - 1] as Comment).createdAt,
    });
  }
  threads.sort((a, b) => b.lastAt.localeCompare(a.lastAt) || b.id.localeCompare(a.id));
  const byNode = new Map<string, Thread[]>();
  const openByNode = new Map<string, number>();
  for (const thread of threads) {
    if (thread.nodeId === undefined) continue;
    byNode.set(thread.nodeId, [...(byNode.get(thread.nodeId) ?? []), thread]);
    if (!thread.resolved) openByNode.set(thread.nodeId, (openByNode.get(thread.nodeId) ?? 0) + 1);
  }
  const open = threads.filter((t) => !t.resolved).length;
  return { threads, byNode, openByNode, open };
}

/** A new comment by `author`: a new thread (on a node or the board) or a reply. */
export function newComment(input: {
  author: Actor;
  body: string;
  mentions?: readonly string[];
  /** Reply to this thread. */
  thread?: Thread;
  /** Start a thread on this node. Ignored for replies. */
  nodeId?: string;
  now?: Date;
}): Comment {
  const id = newId('c');
  const comment: Comment = {
    id,
    thread: input.thread?.id ?? id,
    author: input.author.id,
    body: input.body.trim().slice(0, 4000),
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  const nodeId = input.thread ? input.thread.nodeId : input.nodeId;
  if (nodeId !== undefined) comment.nodeId = nodeId;
  if (input.mentions && input.mentions.length > 0) comment.mentions = [...new Set(input.mentions)];
  return comment;
}

/** The thread's first comment with its resolved state set or cleared. */
export function withResolved(
  head: Comment,
  resolved: boolean,
  by: string,
  now = new Date(),
): Comment {
  const next: Comment = { ...head };
  if (resolved) {
    next.resolvedAt = now.toISOString();
    next.resolvedBy = by;
  } else {
    delete next.resolvedAt;
    delete next.resolvedBy;
  }
  return next;
}

export type ThreadFilter = 'open' | 'resolved' | 'mine';

export function filterThreads(
  threads: readonly Thread[],
  filter: ThreadFilter,
  me: string,
): Thread[] {
  if (filter === 'open') return threads.filter((t) => !t.resolved);
  if (filter === 'resolved') return threads.filter((t) => t.resolved);
  return threads.filter(
    (t) =>
      t.comments.some((c) => c.author === me) || t.comments.some((c) => c.mentions?.includes(me)),
  );
}
