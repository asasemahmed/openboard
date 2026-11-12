/**
 * One open board: the document, the derived canvas store, presence,
 * connection state, undo, and per-board UI state, wired together.
 */
import { type Actor, BoardDoc, MAX_MAX_TOKENS } from '@openboard/core';
import * as Y from 'yjs';
import type { ApiClient } from '../lib/api.js';
import { ActivityStore, itemKey, type RemovalResolver } from './activity.js';
import { BoardStore } from './boardStore.js';
import { ConnectionStore } from './connection.js';
import { PresenceStore } from './presence.js';
import type { Transport } from './transport.js';
import { UiStore } from './ui.js';
import { UndoController } from './undo.js';

export interface BoardSession {
  readonly boardId: string;
  readonly doc: BoardDoc;
  readonly store: BoardStore;
  readonly presence: PresenceStore;
  readonly connection: ConnectionStore;
  readonly undo: UndoController;
  readonly ui: UiStore;
  readonly activity: ActivityStore;
  readonly api: ApiClient;
  actor(): Actor;
  setActor(actor: Actor): void;
  destroy(): void;
}

export interface SessionOptions {
  boardId: string;
  actor: Actor;
  api: ApiClient;
  /** Build the transport for the session's Yjs document. */
  transport: (ydoc: Y.Doc) => Transport;
  /** Use an existing document (tests); defaults to a fresh one filled by the transport. */
  doc?: BoardDoc;
}

export function createSession(options: SessionOptions): BoardSession {
  const doc = options.doc ?? BoardDoc.fromYDoc(new Y.Doc());
  const transport = options.transport(doc.ydoc);
  const store = new BoardStore(doc);
  let actor = options.actor;
  const presence = new PresenceStore(transport.awareness, actor);
  const connection = new ConnectionStore(transport);
  const undo = new UndoController(doc, actor.id);
  const ui = new UiStore();
  const feed = feedResolver(options.api, options.boardId);
  const activity = new ActivityStore({
    me: () => actor.id,
    node: (id) => doc.getNode(id),
    edge: (id) => doc.getEdge(id),
    live: () => connection.get().synced,
    resolveRemovals: feed.resolve,
  });
  const offActivity = doc.observe((event) => {
    // The first change from someone else is a good moment to learn the feed cursor.
    if (!event.local && connection.get().synced) feed.prime();
    activity.onDocEvent(event);
  });

  // Presence must mirror the selection exactly, including when it empties.
  const offSelection = store.onSelectionChange((selection) =>
    presence.setSelection(selection.nodeIds, selection.edgeIds),
  );

  return {
    boardId: options.boardId,
    doc,
    store,
    presence,
    connection,
    undo,
    ui,
    activity,
    api: options.api,
    actor: () => actor,
    setActor(next) {
      if (next.id !== actor.id) throw new Error('the actor id of a session cannot change');
      actor = next;
      presence.setActor(next);
    },
    destroy() {
      offSelection();
      offActivity();
      activity.destroy();
      undo.destroy();
      connection.destroy();
      presence.destroy();
      store.destroy();
      transport.destroy();
      doc.destroy();
    },
  };
}

/**
 * Who removed what, from the server's change feed. The feed cursor is
 * learned on first use and advanced with every answer, so each question only
 * reads what is new.
 */
const FEED_LOOKBACK = 256;

export function feedResolver(
  api: ApiClient,
  boardId: string,
): { resolve: RemovalResolver; prime(): void } {
  let cursor = 0;
  let primed: Promise<void> | null = null;
  return {
    prime() {
      // A cursor past the end returns no entries, only the current cursor.
      primed ??= api
        .changes(boardId, { since: Number.MAX_SAFE_INTEGER, maxTokens: 100 })
        .then((result) => {
          cursor = Math.max(cursor, result.cursor);
        })
        .catch(() => {});
    },
    async resolve(items) {
      if (primed) await primed;
      // Look a little behind the cursor: a removal can race the request that learned it.
      const wanted = new Set(items.map((item) => itemKey(item.kind, item.id)));
      const result = await api.changes(boardId, {
        since: Math.max(0, cursor - FEED_LOOKBACK),
        includeOwn: true,
        maxTokens: MAX_MAX_TOKENS,
      });
      cursor = result.cursor;
      const out = new Map<string, { actorId: string; batchId?: string }>();
      for (const entry of result.changes) {
        if (entry.kind !== 'node_removed' && entry.kind !== 'edge_removed') continue;
        const key = itemKey(entry.kind === 'node_removed' ? 'node' : 'edge', entry.id);
        if (wanted.has(key))
          out.set(key, {
            actorId: entry.actor,
            ...(entry.batchId ? { batchId: entry.batchId } : {}),
          });
      }
      return out;
    },
  };
}
