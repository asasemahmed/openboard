/** What the connection indicator shows. */
import { Emitter } from './emitter.js';
import type { Transport } from './transport.js';

export type ConnectionStatus = 'connecting' | 'live' | 'offline';

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  /** The document has been synced with the server at least once. */
  synced: boolean;
  /** A connection succeeded at some point in this session. */
  everLive: boolean;
  /** The server reported that the board no longer exists. */
  gone: boolean;
  /** The server refused this tab's document as out of date; it must be replaced. */
  stale: boolean;
}

export class ConnectionStore extends Emitter {
  private snapshot: ConnectionSnapshot;
  private readonly detach: () => void;
  private readonly transport: Transport;

  constructor(transport: Transport) {
    super();
    this.transport = transport;
    this.snapshot = this.read(false);
    this.detach = transport.onChange(() => {
      const next = this.read(this.snapshot.everLive);
      const s = this.snapshot;
      if (
        next.status !== s.status ||
        next.synced !== s.synced ||
        next.everLive !== s.everLive ||
        next.gone !== s.gone ||
        next.stale !== s.stale
      ) {
        this.snapshot = next;
        this.emit();
      }
    });
  }

  private read(everLive: boolean): ConnectionSnapshot {
    const link = this.transport.status();
    const synced = this.transport.synced() || this.snapshot?.synced === true;
    const status: ConnectionStatus =
      link === 'connected' ? 'live' : link === 'connecting' && !everLive ? 'connecting' : 'offline';
    return {
      status,
      synced,
      everLive: everLive || link === 'connected',
      gone: this.transport.gone(),
      stale: this.transport.stale(),
    };
  }

  readonly get = (): ConnectionSnapshot => this.snapshot;

  /** Local edits the server has not seen. */
  dirty(): boolean {
    return this.transport.dirty();
  }

  reconnect(): void {
    this.transport.reconnect();
  }

  destroy(): void {
    this.detach();
  }
}
