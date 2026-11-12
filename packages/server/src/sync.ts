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
 * awareness. Auth (2) is only sent, never read: see read-only connections.
 *
 * Attribution: updates from a connection are applied with the transaction
 * origin `doc.origin(<connection actor>, 'sync')`, a proper `TxOrigin`. The
 * change feed reads the actor from the origin, so every change that arrives
 * over a socket is attributed to the connection's actor, with no side table to
 * keep in step.
 *
 * Shared mode (see auth.ts): the upgrade must carry the session cookie,
 * `Authorization: Bearer <token>`, or `?ticket=` from `POST /api/auth/ticket`,
 * unless it is the owner at this machine; the actor is then the grant's and
 * the `actor*` parameters only name it. A connection whose role cannot edit
 * boards, or whose actor is an agent (agents change boards through the API,
 * where the review policy applies), is read-only: its sync step 2 and update
 * messages are dropped unapplied, and the first dropped update is answered
 * with one y-protocols auth "permission denied" message. Presence still works.
 *
 * Presence from clients is checked in both modes: an entry may only use an
 * awareness client id the connection owns (or a fresh one), at most 16 KB,
 * and its `actor` is always rewritten to the connection's actor id and kind;
 * `agent` and `live`, which only the server publishes, are removed.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Actor, TxOrigin } from '@openboard/core';
import { ColorSchema, can, OpenBoardError } from '@openboard/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import * as authProtocol from 'y-protocols/auth';
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { actorFromQuery } from './actor.js';
import { type Auth, type Caller, headerGetter, scrubSecrets } from './auth.js';
import type { Boards } from './boards.js';
import { errorMessage } from './fsutil.js';
import { redactPresenceState, seesActivityDetail } from './live.js';
import { isBoardId } from './paths.js';
import type { Room } from './room.js';
import { checkRequest, type SecurityConfig } from './security.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_QUERY_AWARENESS = 3;

/** Close codes in the application range (4000-4999). */
export const CLOSE_BOARD_NOT_FOUND = 4404;
export const CLOSE_UNAVAILABLE = 4503;
/** The client's document belongs to another lineage; reload the board before syncing again. */
export const CLOSE_STALE_DOCUMENT = 4409;
/**
 * Shared mode: the connection's credentials no longer hold (the grant was
 * revoked or expired, or the browser signed out). Do not reconnect with the
 * same credentials; sign in again.
 */
export const CLOSE_ACCESS_REVOKED = 4401;
const CLOSE_BAD_MESSAGE = 1007;
const CLOSE_GOING_AWAY = 1001;

const PING_INTERVAL_MS = 30_000;
/** Generous: a board document with history can be large, but not unbounded. */
const MAX_PAYLOAD = 32 * 1024 * 1024;
/** Open sockets one grant may hold at a time. */
export const MAX_SOCKETS_PER_GRANT = 32;
/** Largest presence state a client may publish, as JSON. */
export const MAX_AWARENESS_STATE_BYTES = 16 * 1024;
/** Awareness client ids one connection may control. */
const MAX_CLIENTS_PER_CONNECTION = 4;

export interface SyncOptions {
  security: () => SecurityConfig;
  log?: (line: string) => void;
  /** Authentication; without it the server is in local mode. */
  auth?: Auth;
}

interface Connection {
  socket: WebSocket;
  room: Room;
  actor: Actor;
  caller: Caller | null;
  origin: TxOrigin;
  /** Awareness client ids this connection controls, removed when it closes. */
  clients: Set<number>;
  alive: boolean;
  /** Document updates from this connection are dropped. */
  readOnly: boolean;
  /** Whether the client was told it is read-only. */
  told: boolean;
  /** Agent activity detail is taken out of the presence this connection receives (see live.ts). */
  redacted: boolean;
}

/** Room listeners shared by all connections of one board. */
interface RoomHub {
  connections: Set<Connection>;
  detach: () => void;
}

export class SyncServer {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  private readonly hubs = new Map<Room, RoomHub>();
  /** Every open socket, with its caller in shared mode. */
  private readonly sockets = new Map<WebSocket, Caller | null>();
  private readonly perGrant = new Map<string, number>();
  private readonly pinger: NodeJS.Timeout;
  private readonly log: (line: string) => void;
  private readonly stopListening: () => void;

  constructor(
    private readonly boards: Boards,
    private readonly opts: SyncOptions,
  ) {
    this.log = (line) => (opts.log ?? (() => {}))(scrubSecrets(line));
    this.pinger = setInterval(() => this.ping(), PING_INTERVAL_MS);
    this.pinger.unref();
    this.stopListening =
      opts.auth?.store.onEnd((end) => {
        for (const [ws, caller] of this.sockets) {
          if (!caller || caller.grantId !== end.grantId) continue;
          if (end.sessionHash !== undefined && caller.sessionHash !== end.sessionHash) continue;
          ws.close(CLOSE_ACCESS_REVOKED, 'access ended');
        }
      }) ?? (() => {});
  }

  private get shared(): boolean {
    return this.opts.auth?.shared === true;
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
    if (!verdict.ok) return reject(socket, new OpenBoardError('forbidden', verdict.reason));

    let boardId: string;
    try {
      boardId = decodeURIComponent(match[1] as string);
    } catch {
      return reject(socket, new OpenBoardError('invalid_request', 'invalid board id'));
    }
    if (!isBoardId(boardId)) {
      return reject(socket, new OpenBoardError('invalid_request', 'invalid board id'));
    }
    if (url.searchParams.has('token')) {
      return reject(
        socket,
        new OpenBoardError(
          'invalid_request',
          'never put an access token in a URL; send "Authorization: Bearer <token>" or use a ticket from POST /api/auth/ticket',
        ),
      );
    }

    let actor: Actor;
    let caller: Caller | null = null;
    const auth = this.opts.auth;
    if (auth) {
      const header = headerGetter(request.headers);
      const outcome = auth.authenticate(
        {
          remoteAddress: request.socket.remoteAddress,
          host: request.headers.host,
          header,
          headerNames: () => Object.keys(request.headers),
          method: 'GET',
        },
        {
          ticket: url.searchParams.get('ticket'),
          localActor: () => {
            const local = actorFromQuery(url.searchParams);
            return { actor: local, anonymous: false };
          },
        },
      );
      if (!outcome.ok) return reject(socket, outcome.error);
      caller = outcome.caller;
      // Browsers always send Origin on an upgrade; a cookie without it is not the app.
      if (caller.via === 'session' && request.headers.origin === undefined) {
        return reject(
          socket,
          new OpenBoardError(
            'forbidden',
            'a socket opened with the session cookie needs an Origin',
          ),
        );
      }
      if (caller.grantId !== undefined) {
        const open = this.perGrant.get(caller.grantId) ?? 0;
        if (open >= MAX_SOCKETS_PER_GRANT) {
          return reject(
            socket,
            new OpenBoardError(
              'rate_limited',
              `this access grant already has ${MAX_SOCKETS_PER_GRANT} open sync connections`,
              { retryAfterSeconds: 30 },
            ),
          );
        }
      }
      actor = caller.actor;
    } else {
      try {
        actor = actorFromQuery(url.searchParams);
      } catch (error) {
        return reject(socket, new OpenBoardError('invalid_request', errorMessage(error)));
      }
    }
    // In shared mode only people with a role that edits boards write through
    // sync; the owner at this machine keeps today's behaviour.
    const readOnly =
      caller !== null &&
      this.shared &&
      caller.via !== 'local' &&
      !(can(caller.role, 'board.edit') && caller.actor.kind === 'human');

    const grantId = caller?.grantId;
    // Counted once the socket is open: a handshake that ws refuses (no
    // Sec-WebSocket-Key, say) never calls back, and must not use up a slot.
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      if (grantId !== undefined) this.perGrant.set(grantId, (this.perGrant.get(grantId) ?? 0) + 1);
      this.sockets.set(ws, caller);
      ws.on('close', () => {
        this.sockets.delete(ws);
        if (grantId !== undefined) {
          const left = (this.perGrant.get(grantId) ?? 1) - 1;
          if (left <= 0) this.perGrant.delete(grantId);
          else this.perGrant.set(grantId, left);
        }
      });
      ws.on('error', () => {});
      void this.attach(ws, boardId, actor, caller, readOnly, url.searchParams.get('lineage'));
    });
    return true;
  }

  private async attach(
    ws: WebSocket,
    boardId: string,
    actor: Actor,
    caller: Caller | null,
    readOnly: boolean,
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
      caller,
      origin: room.doc.origin(actor.id, 'sync'),
      clients: new Set(),
      alive: true,
      readOnly,
      told: false,
      redacted: caller !== null && !seesActivityDetail(caller),
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
    if (states.size > 0) send(conn, awarenessMessage(conn, [...states.keys()]));

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
      // Built at most twice: in full, and redacted for roles that may not see agent activity.
      const messages = new Map<boolean, Uint8Array>();
      for (const conn of connections) {
        let message = messages.get(conn.redacted);
        if (!message) {
          message = awarenessMessage(conn, changed);
          messages.set(conn.redacted, message);
        }
        send(conn, message);
      }
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
          if (conn.readOnly) this.readOnlySync(conn, decoder, encoder);
          else {
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
          }
          // Only step 1 produces a reply (our step 2); updates do not.
          if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
          break;
        }
        case MESSAGE_AWARENESS: {
          const update = cleanAwareness(
            conn,
            this.hubs.get(conn.room),
            decoding.readVarUint8Array(decoder),
          );
          if (update) applyAwarenessUpdate(conn.room.awareness, update, conn);
          break;
        }
        case MESSAGE_QUERY_AWARENESS:
          send(conn, awarenessMessage(conn, [...conn.room.awareness.getStates().keys()]));
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

  /**
   * A read-only connection may ask for the document (step 1) but its own
   * state (step 2) and edits (update) are dropped unread. The first dropped
   * edit gets one "permission denied" answer, which `WebsocketProvider` logs.
   */
  private readOnlySync(
    conn: Connection,
    decoder: decoding.Decoder,
    encoder: encoding.Encoder,
  ): void {
    const subtype = decoding.readVarUint(decoder);
    if (subtype === syncProtocol.messageYjsSyncStep1) {
      syncProtocol.readSyncStep1(decoder, encoder, conn.room.doc.ydoc);
      return;
    }
    if (subtype !== syncProtocol.messageYjsSyncStep2 && subtype !== syncProtocol.messageYjsUpdate) {
      throw new Error(`unknown sync message ${subtype}`);
    }
    decoding.readVarUint8Array(decoder);
    if (subtype === syncProtocol.messageYjsUpdate && !conn.told) {
      conn.told = true;
      const deny = encoding.createEncoder();
      encoding.writeVarUint(deny, MESSAGE_AUTH);
      authProtocol.writePermissionDenied(
        deny,
        `read-only: your access (${conn.caller?.role ?? 'viewer'}${conn.actor.kind === 'agent' ? ', agent' : ''}) does not change boards over sync; edits are not saved`,
      );
      send(conn, encoding.toUint8Array(deny));
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
    // Expired grants and idle sessions end here, within one interval.
    const auth = this.opts.auth;
    if (auth) {
      for (const [ws, caller] of this.sockets) {
        if (caller && !auth.stillValid(caller)) ws.close(CLOSE_ACCESS_REVOKED, 'access ended');
      }
    }
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
    this.stopListening();
    const closed = [...this.sockets.keys()].map(
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

/**
 * A client's awareness update, checked and rewritten: entries for client ids
 * the connection does not own (another client's, or a server entry) and
 * oversized ones are dropped, and each state's `actor` is set to the
 * connection's actor id and kind (the name and color may be the client's).
 * Null when nothing is left.
 */
function cleanAwareness(
  conn: Connection,
  hub: RoomHub | undefined,
  update: Uint8Array,
): Uint8Array | null {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const states = conn.room.awareness.getStates();
  const ownerOf = new Map<number, Connection>();
  for (const other of hub?.connections ?? []) {
    if (other !== conn) for (const id of other.clients) ownerOf.set(id, other);
  }
  const kept: Array<{ id: number; clock: number; json: string }> = [];
  for (let i = 0; i < count; i++) {
    const id = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const raw = decoding.readVarString(decoder);
    if (raw.length > MAX_AWARENESS_STATE_BYTES) continue;
    if (!conn.clients.has(id)) {
      const owner = ownerOf.get(id);
      // Another actor's entry, or one the server publishes (agents, sessions): never ours.
      if (owner ? owner.actor.id !== conn.actor.id : states.has(id)) continue;
      if (conn.clients.size >= MAX_CLIENTS_PER_CONNECTION) continue;
      // The same actor reconnecting before its old socket was noticed gone takes its entry over.
      owner?.clients.delete(id);
      conn.clients.add(id);
    }
    let state: unknown;
    try {
      state = JSON.parse(raw);
    } catch {
      continue;
    }
    if (state === null) {
      kept.push({ id, clock, json: 'null' });
      continue;
    }
    if (typeof state !== 'object' || Array.isArray(state)) continue;
    const {
      agent: _agent,
      live: _live,
      actor: claimed,
      ...rest
    } = state as Record<string, unknown>;
    const actor: Actor = { ...conn.actor };
    if (typeof claimed === 'object' && claimed !== null) {
      const { name, color } = claimed as { name?: unknown; color?: unknown };
      if (typeof name === 'string' && name.trim() !== '' && name.length <= 80) actor.name = name;
      if (typeof color === 'string' && ColorSchema.safeParse(color).success) actor.color = color;
    }
    kept.push({ id, clock, json: JSON.stringify({ ...rest, actor }) });
  }
  if (kept.length === 0) return null;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, kept.length);
  for (const entry of kept) {
    encoding.writeVarUint(encoder, entry.id);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.json);
  }
  return encoding.toUint8Array(encoder);
}

/**
 * The awareness message for `clients`, as `conn` may see it. Every awareness
 * message a connection receives is built here, so a redacted connection
 * never gets agent activity detail by another path.
 */
function awarenessMessage(conn: Connection, clients: number[]): Uint8Array {
  const awareness = conn.room.awareness;
  let states = awareness.getStates();
  if (conn.redacted) {
    const redacted = new Map<number, Record<string, unknown>>();
    for (const id of clients) {
      const state = states.get(id);
      if (state !== undefined)
        redacted.set(id, redactPresenceState(state) as Record<string, unknown>);
    }
    states = redacted;
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clients, states));
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

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  429: 'Too Many Requests',
};

/** Refuse an upgrade with a plain HTTP response. Always returns true: the request was ours. */
function reject(socket: Duplex, error: OpenBoardError): true {
  const status = error.status;
  const body = JSON.stringify({
    error: { code: error.code, message: scrubSecrets(error.message) },
  });
  const extra: string[] = [];
  const retry = (error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  if (typeof retry === 'number') extra.push(`Retry-After: ${retry}`);
  if (status === 401) extra.push('WWW-Authenticate: Bearer realm="openboard"');
  socket.end(
    [
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
      'Connection: close',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      ...extra,
      '',
      body,
    ].join('\r\n'),
  );
  return true;
}
