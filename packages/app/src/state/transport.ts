/**
 * How a session reaches the server. The real transport is y-websocket; tests
 * and offline previews use the local one, which never leaves the page.
 */
import type { Actor } from '@openboard/core';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';

import { CLOSE_ACCESS_REVOKED, CLOSE_BOARD_NOT_FOUND, CLOSE_STALE_DOCUMENT } from './lineage.js';

export { CLOSE_ACCESS_REVOKED, CLOSE_BOARD_NOT_FOUND, CLOSE_STALE_DOCUMENT };

export type LinkStatus = 'connecting' | 'connected' | 'disconnected';

export interface Transport {
  readonly awareness: Awareness;
  status(): LinkStatus;
  synced(): boolean;
  /** True once the server said the board does not exist (it then stops reconnecting). */
  gone(): boolean;
  /**
   * True once the server refused this document as belonging to another
   * lineage (it then stops reconnecting; the document must be replaced).
   */
  stale(): boolean;
  /** Local edits were made that the server has not seen (made while not connected and synced). */
  dirty(): boolean;
  /** True once the server ended this connection's access (it then stops reconnecting). */
  revoked(): boolean;
  /** Called whenever `status()` or `synced()` may have changed. */
  onChange(listener: () => void): () => void;
  /** Try to connect again now instead of waiting for the next backoff. */
  reconnect(): void;
  destroy(): void;
}

export function syncUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/sync`;
}

export function createWebsocketTransport(
  ydoc: Y.Doc,
  boardId: string,
  actor: Actor,
  lineage: string | null,
): Transport {
  const provider = new WebsocketProvider(syncUrl(), boardId, ydoc, {
    params: {
      actorId: actor.id,
      actorName: actor.name,
      actorKind: 'human',
      ...(lineage ? { lineage } : {}),
    },
    maxBackoffTime: 5000,
    // Tabs of the same origin would otherwise share documents over a
    // BroadcastChannel, past the lineage check: a tab left open from an earlier
    // server could pour its board into a fresh one. Every tab syncs through
    // the server instead.
    disableBc: true,
  });
  const listeners = new Set<() => void>();
  let status: LinkStatus = 'connecting';
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const onStatus = (event: { status: LinkStatus }) => {
    status = event.status;
    notify();
  };
  let gone = false;
  let stale = false;
  let dirty = false;
  let revoked = false;
  const onClose = (event: CloseEvent | null) => {
    const code = event?.code;
    if (
      code === CLOSE_BOARD_NOT_FOUND ||
      code === CLOSE_STALE_DOCUMENT ||
      code === CLOSE_ACCESS_REVOKED
    ) {
      if (code === CLOSE_BOARD_NOT_FOUND) gone = true;
      else if (code === CLOSE_STALE_DOCUMENT) stale = true;
      // Access ended: reconnecting would only be refused again. Sign in anew instead.
      else revoked = true;
      provider.disconnect();
      notify();
    }
  };
  // Updates from the server carry the provider as origin; anything else was made
  // here, and is unseen by the server unless the socket was up and synced.
  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === provider || dirty) return;
    if (!(provider.wsconnected && provider.synced)) dirty = true;
  };
  const onSynced = () => {
    if (provider.synced && provider.wsconnected) dirty = false;
    notify();
  };
  ydoc.on('update', onUpdate);
  provider.on('status', onStatus);
  provider.on('sync', onSynced);
  provider.on('connection-close', onClose);
  const onOnline = () => {
    if (!provider.wsconnected) provider.connect();
  };
  window.addEventListener('online', onOnline);

  return {
    awareness: provider.awareness,
    status: () => status,
    synced: () => provider.synced,
    gone: () => gone,
    stale: () => stale,
    dirty: () => dirty,
    revoked: () => revoked,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect: () => {
      provider.disconnect();
      provider.connect();
    },
    destroy: () => {
      window.removeEventListener('online', onOnline);
      provider.off('status', onStatus);
      provider.off('sync', onSynced);
      ydoc.off('update', onUpdate);
      provider.off('connection-close', onClose);
      provider.awareness.setLocalState(null);
      provider.destroy();
    },
  };
}

/** A transport that is always "connected" and synced, with a private awareness. */
export function createLocalTransport(ydoc: Y.Doc): Transport {
  const awareness = new Awareness(ydoc);
  return {
    awareness,
    status: () => 'connected',
    synced: () => true,
    gone: () => false,
    stale: () => false,
    dirty: () => false,
    revoked: () => false,
    onChange: () => () => {},
    reconnect: () => {},
    destroy: () => awareness.destroy(),
  };
}
