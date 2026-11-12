/**
 * One open board: the document, the derived canvas store, presence,
 * connection state, undo, and per-board UI state, wired together.
 */
import { type Actor, BoardDoc } from '@openboard/core';
import * as Y from 'yjs';
import type { ApiClient } from '../lib/api.js';
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
    api: options.api,
    actor: () => actor,
    setActor(next) {
      if (next.id !== actor.id) throw new Error('the actor id of a session cannot change');
      actor = next;
      presence.setActor(next);
    },
    destroy() {
      offSelection();
      undo.destroy();
      connection.destroy();
      presence.destroy();
      store.destroy();
      transport.destroy();
      doc.destroy();
    },
  };
}
