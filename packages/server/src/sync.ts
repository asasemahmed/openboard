/**
 * Document sync and presence over WebSocket, speaking the standard
 * y-websocket protocol so the stock `WebsocketProvider` works unmodified:
 *
 *   ws://<host>/sync/<boardId>?lineage=..&actorId=..&actorName=..&actorKind=..
 *
 * `lineage` must be the live document's lineage (from the board listing or the
 * `x-openboard-lineage` header of `GET /api/boards/:id`). A socket without it,
 * or with another one, is closed with `CLOSE_STALE_DOCUMENT` before anything it
 * sent is applied: it holds a document from an earlier server or an earlier
 * life of this board, and merging it would bring back what is gone.
 *
 * Message types: 0 sync (step 1, step 2, update), 1 awareness, 3 query
 * awareness. Auth (2) is not used.
 *
 * Attribution: updates from a connection are applied with the transaction
 * origin `doc.origin(<connection actor>, 'sync')`, a proper `TxOrigin`. The
 * change feed reads the actor from the origin, so every change that arrives
 * over a socket is attributed to the actor that connection declared, with no
 * side table to keep in step.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Actor, TxOrigin } from '@openboard/core';
import { OpenBoardError } from '@openboard/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { actorFromQuery } from './actor.js';
import type { Boards } from './boards.js';
import { errorMessage } from './fsutil.js';
import { isBoardId } from './paths.js';
import type { Room } from './room.js';
import { checkRequest, type SecurityConfig } from './security.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

/** Close codes in the application range (4000-4999). */
export const CLOSE_BOARD_NOT_FOUND = 4404;
export const CLOSE_UNAVAILABLE = 4503;
/** The client's document belongs to another lineage; reload the board before syncing again. */
export const CLOSE_STALE_DOCUMENT = 4409;
const CLOSE_BAD_MESSAGE = 1007;
const CLOSE_GOING_AWAY = 1001;

const PING_INTERVAL_MS = 30_000;
/** Generous: a board document with history can be large, but not unbounded. */
const MAX_PAYLOAD = 32 * 1024 * 1024;

export interface SyncOptions {
  security: () => SecurityConfig;
  log?: (line: string) => void;
}

interface Connection {
  socket: WebSocket;
  room: Room;
  actor: Actor;
  origin: TxOrigin;
  /** Awareness client ids this connection controls, removed when it closes. */
  clients: Set<number>;
  alive: boolean;
}

/** Room listeners shared by all connections of one board. */
interface RoomHub {
  connections: Set<Connection>;
  detach: () => void;
}

export class SyncServer {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  private readonly hubs = new Map<Room, RoomHub>();
  private readonly sockets = new Set<WebSocket>();
  private readonly pinger: NodeJS.Timeout;
  private readonly log: (line: string) => void;

  constructor(
    private readonly boards: Boards,
    private readonly opts: SyncOptions,
  ) {
    this.log = opts.log ?? (() => {});
    this.pinger = setInterval(() => this.ping(), PING_INTERVAL_MS);
    this.pinger.unref();
  }

  /** Handle an HTTP upgrade. Returns false when the path is not ours, so another handler may take it. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/sync\/([^/]+)$/.exec(url.pathname);
    if (!match) return false;
    socket.on('error', () => socket.destroy());

    const verdict = checkRequest(
      this.opts.security(),
      { host: request.headers.host, origin: request.headers.origin },
      true,
    );
    if (!verdict.ok) return reject(socket, 403, 'Forbidden', verdict.reason);

    let boardId: string;
    try {
      boardId = decodeURIComponent(match[1] as string);
    } catch {
      return reject(socket, 400, 'Bad Request', 'invalid board id');
    }
    if (!isBoardId(boardId)) return reject(socket, 400, 'Bad Request', 'invalid board id');

    let actor: Actor;
    try {
      actor = actorFromQuery(url.searchParams);
    } catch (error) {
      return reject(socket, 400, 'Bad Request', errorMessage(error));
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.on('error', () => {});
      void this.attach(ws, boardId, actor, url.searchParams.get('lineage'));
    });
    return true;
  }

  private async attach(
    ws: WebSocket,
    boardId: string,
    actor: Actor,
    lineage: string | null,
  ): Promise<void> {
    // Messages that arrive while the board loads are handled once it has.
    const early: RawData[] = [];
    const buffer = (data: RawData) => early.push(data);
    ws.on('message', buffer);

    let room: Room | null;
    try {
      room = await this.boards.find(boardId);
    } catch (error) {
      const unavailable = error instanceof OpenBoardError && error.code === 'unavailable';
      ws.close(
        CLOSE_UNAVAILABLE,
        unavailable ? 'server is shutting down' : 'board cannot be opened',
      );
      if (!unavailable)
        this.log(`sync: board "${boardId}" cannot be opened: ${errorMessage(error)}`);
      return;
    }
    ws.off('message', buffer);
    if (!room) {
      ws.close(CLOSE_BOARD_NOT_FOUND, 'board not found');
      return;
    }
    if (lineage !== room.lineage) {
      // Messages buffered while the board loaded are dropped unread.
      ws.close(
        CLOSE_STALE_DOCUMENT,
        lineage ? 'document lineage does not match; reload the board' : 'lineage is required',
      );
      return;
    }
    if (ws.readyState !== ws.OPEN) return;
    room.viewers++;

    room.knownActors.set(actor.id, actor);
    const conn: Connection = {
      socket: ws,
      room,
      actor,
      origin: room.doc.origin(actor.id, 'sync'),
      clients: new Set(),
      alive: true,
    };
    const hub = this.hub(room);
    hub.connections.add(conn);

    ws.on('message', (data) => this.receive(conn, data));
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('close', () => this.detach(conn));

    // Start the handshake: our state vector, then everyone's presence.
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(step1, room.doc.ydoc);
    send(conn, encoding.toUint8Array(step1));
    const states = room.awareness.getStates();
    if (states.size > 0) send(conn, awarenessMessage(room, [...states.keys()]));

    for (const data of early) this.receive(conn, data);
  }

  private hub(room: Room): RoomHub {
    const existing = this.hubs.get(room);
    if (existing) return existing;
    const connections = new Set<Connection>();
    const onUpdate = (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const conn of connections) send(conn, message);
    };
    const onAwareness = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const changed = [...changes.added, ...changes.updated, ...changes.removed];
      const owner = [...connections].find((conn) => conn === origin);
      if (owner) {
        for (const id of changes.added) owner.clients.add(id);
        for (const id of changes.removed) owner.clients.delete(id);
      }
      const message = awarenessMessage(room, changed);
      for (const conn of connections) send(conn, message);
    };
    room.doc.ydoc.on('update', onUpdate);
    room.awareness.on('update', onAwareness);
    const hub: RoomHub = {
      connections,
      detach: () => {
        room.doc.ydoc.off('update', onUpdate);
        room.awareness.off('update', onAwareness);
      },
    };
    this.hubs.set(room, hub);
    return hub;
  }

  private receive(conn: Connection, data: RawData): void {
    try {
      const message = toBytes(data);
      const decoder = decoding.createDecoder(message);
      const type = decoding.readVarUint(decoder);
      switch (type) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(
            decoder,
            encoder,
            conn.room.doc.ydoc,
            conn.origin,
            // y-protocols logs a broken update and carries on; treat it as a bad message instead.
            (error: Error) => {
              throw error;
            },
          );
          // Only step 1 produces a reply (our step 2); updates do not.
          if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
          break;
        }
        case MESSAGE_AWARENESS:
          applyAwarenessUpdate(conn.room.awareness, decoding.readVarUint8Array(decoder), conn);
          break;
        case MESSAGE_QUERY_AWARENESS:
          send(conn, awarenessMessage(conn.room, [...conn.room.awareness.getStates().keys()]));
          break;
        default:
          // Unknown message types (auth included) are ignored, as the reference server does.
          break;
      }
    } catch (error) {
      this.log(`sync: closing a connection to "${conn.room.id}": ${errorMessage(error)}`);
      conn.socket.close(CLOSE_BAD_MESSAGE, 'malformed message');
    }
  }

  private detach(conn: Connection): void {
    const hub = this.hubs.get(conn.room);
    if (!hub || !hub.connections.delete(conn)) return;
    conn.room.viewers = Math.max(0, conn.room.viewers - 1);
    if (conn.clients.size > 0) {
      removeAwarenessStates(conn.room.awareness, [...conn.clients], null);
    }
    if (hub.connections.size === 0) {
      hub.detach();
      this.hubs.delete(conn.room);
    }
  }

  private ping(): void {
    for (const hub of this.hubs.values()) {
      for (const conn of hub.connections) {
        if (!conn.alive) {
          conn.socket.terminate();
          this.detach(conn);
          continue;
        }
        conn.alive = false;
        try {
          conn.socket.ping();
        } catch {
          conn.socket.terminate();
        }
      }
    }
  }

  /** Close every socket and stop the keep-alive timer. */
  async close(): Promise<void> {
    clearInterval(this.pinger);
    const closed = [...this.sockets].map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === ws.CLOSED) return resolve();
          const timer = setTimeout(() => {
            ws.terminate();
            resolve();
          }, 1000);
          ws.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          ws.close(CLOSE_GOING_AWAY, 'server is shutting down');
        }),
    );
    await Promise.all(closed);
    for (const hub of this.hubs.values()) hub.detach();
    this.hubs.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

function awarenessMessage(room: Room, clients: number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(room.awareness, clients));
  return encoding.toUint8Array(encoder);
}

function send(conn: Connection, message: Uint8Array): void {
  if (conn.socket.readyState !== conn.socket.OPEN) return;
  conn.socket.send(message, (error) => {
    if (error) conn.socket.terminate();
  });
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Refuse an upgrade with a plain HTTP response. Always returns true: the request was ours. */
function reject(socket: Duplex, status: number, statusText: string, reason: string): true {
  const body = JSON.stringify({
    error: { code: status === 403 ? 'forbidden' : 'invalid_request', message: reason },
  });
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  return true;
}
