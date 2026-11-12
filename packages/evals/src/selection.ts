/**
 * A person's canvas selection, published the way the browser publishes it.
 *
 * The browser joins a board's sync socket (the y-websocket protocol) and sets
 * `selection` in its awareness state; the server reads the most recent human
 * selection from there. This client does only the awareness half of that
 * protocol, with Node's built-in WebSocket and hand-written lib0 framing, so
 * the harness needs no Yjs dependency: it never syncs the document itself,
 * which the server does not require.
 */
import type { Actor } from '@openboard/core';

const MESSAGE_AWARENESS = 1;

/** lib0 variable-length unsigned integer. */
function writeVarUint(out: number[], value: number): void {
  let rest = value;
  while (rest > 0x7f) {
    out.push(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
  out.push(rest & 0x7f);
}

function writeVarBytes(out: number[], bytes: Uint8Array): void {
  writeVarUint(out, bytes.length);
  for (const byte of bytes) out.push(byte);
}

/**
 * One y-protocols awareness update for a single client, wrapped as a
 * y-websocket awareness message: type, then the update as a byte string of
 * `[count, clientId, clock, JSON state]`.
 */
export function encodeAwarenessMessage(
  clientId: number,
  clock: number,
  state: unknown,
): Uint8Array {
  const update: number[] = [];
  writeVarUint(update, 1);
  writeVarUint(update, clientId);
  writeVarUint(update, clock);
  writeVarBytes(update, new TextEncoder().encode(JSON.stringify(state)));
  const message: number[] = [];
  writeVarUint(message, MESSAGE_AWARENESS);
  writeVarBytes(message, Uint8Array.from(update));
  return Uint8Array.from(message);
}

export interface SelectionPublisher {
  select(nodeIds: string[], edgeIds?: string[]): Promise<void>;
  close(): Promise<void>;
}

/** Join `board` on the server at `serverUrl` as `actor`, ready to publish selections. */
export async function openSelectionPublisher(
  serverUrl: string,
  board: string,
  actor: Actor,
): Promise<SelectionPublisher> {
  const head = await fetch(`${serverUrl}/api/boards/${encodeURIComponent(board)}`);
  const lineage = head.headers.get('x-openboard-lineage');
  await head.body?.cancel();
  if (!lineage) throw new Error(`no lineage for board "${board}"`);
  const params = new URLSearchParams({
    lineage,
    actorId: actor.id,
    actorName: actor.name,
    actorKind: actor.kind,
  });
  const socket = new WebSocket(
    `${serverUrl.replace(/^http/, 'ws')}/sync/${encodeURIComponent(board)}?${params}`,
  );
  socket.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('cannot join the board socket')), {
      once: true,
    });
  });
  const clientId = Math.floor(Math.random() * 0xffffffff);
  let clock = 0;
  return {
    async select(nodeIds, edgeIds = []) {
      clock++;
      const state = { actor, selection: { nodeIds, edgeIds, at: new Date().toISOString() } };
      socket.send(encodeAwarenessMessage(clientId, clock, state));
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        socket.addEventListener(
          'close',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.close();
      });
    },
  };
}
