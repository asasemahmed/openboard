/**
 * How a session reaches the server. The real transport is y-websocket; tests
 * and offline previews use the local one, which never leaves the page.
 */
import type { Actor } from '@openboard/core';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';

/** WebSocket close code the server uses when a board does not exist. */
export const CLOSE_BOARD_NOT_FOUND = 4404;

export type LinkStatus = 'connecting' | 'connected' | 'disconnected';

export interface Transport {
  readonly awareness: Awareness;
  status(): LinkStatus;
  synced(): boolean;
  /** True once the server said the board does not exist (it then stops reconnecting). */
  gone(): boolean;
  /** Called whenever `status()` or `synced()` may have changed. */
  onChange(listener: () => void): () => void;
  /** Try to connect again now instead of waiting for the next backoff. */
  reconnect(): void;
  destroy(): void;
}

export function syncUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/sync`;
}

export function createWebsocketTransport(ydoc: Y.Doc, boardId: string, actor: Actor): Transport {
  const provider = new WebsocketProvider(syncUrl(), boardId, ydoc, {
    params: { actorId: actor.id, actorName: actor.name, actorKind: 'human' },
    maxBackoffTime: 5000,
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
  const onClose = (event: CloseEvent | null) => {
    if (event?.code === CLOSE_BOARD_NOT_FOUND) {
      gone = true;
      provider.disconnect();
      notify();
    }
  };
  provider.on('status', onStatus);
  provider.on('sync', notify);
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
      provider.off('sync', notify);
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
    onChange: () => () => {},
    reconnect: () => {},
    destroy: () => awareness.destroy(),
  };
}
