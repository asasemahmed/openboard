import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Actor, BoardDoc, type Op, OpenBoardError, serializeBoard } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { projectPaths } from './paths.js';
import { CLOSE_STALE_DOCUMENT } from './sync.js';
import {
  api,
  lineageOf,
  removeRoot,
  sleep,
  startTestServer,
  tempRoot,
  waitFor,
} from './testing.js';
import type { OpenBoardServer } from './types.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const BOT: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };

let root: string;
let server: OpenBoardServer;

beforeEach(async () => {
  root = await tempRoot();
  server = await startTestServer(root);
  await server.api(ADA).createBoard({ name: 'Plan' });
  await server.api(ADA).setConfig({ version: 1, policy: { default: 'auto', agents: {} } });
});

afterEach(async () => {
  await server.close();
  await removeRoot(root);
});

/** A small deterministic random sequence. */
function random(seed: number) {
  let state = seed;
  return (n: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
}

describe('snapshotAt', () => {
  it('reproduces the board exactly after every batch', async () => {
    const pick = random(7);
    const ada = server.api(ADA);
    const bot = server.api(BOT);
    const recorded: Array<{ cursor: number; text: string }> = [];
    const record = async () => {
      const outline = await ada.outline('plan');
      recorded.push({ cursor: outline.cursor, text: serializeBoard(await ada.getBoard('plan')) });
    };
    await record();
    for (let i = 0; i < 40; i++) {
      const board = await ada.getBoard('plan');
      const nodes = Object.keys(board.nodes);
      const who = pick(2) === 0 ? ada : bot;
      const roll = pick(9);
      if (roll <= 2 || nodes.length < 3) {
        const parent = Object.values(board.nodes).find((n) => n.type === 'frame');
        await who.apply('plan', {
          ops: [
            {
              op: 'add_node',
              node: {
                type: pick(4) === 0 ? 'frame' : 'task',
                title: `Node ${i}`,
                ...(parent && pick(2) === 0 ? { parent: parent.id } : {}),
              },
            },
          ],
        });
      } else if (roll === 3) {
        const id = nodes[pick(nodes.length)] as string;
        await who.apply('plan', {
          ops: [{ op: 'update_node', id, patch: { title: `Renamed ${i}`, status: 'done' } }],
        });
      } else if (roll === 4) {
        const id = nodes[pick(nodes.length)] as string;
        await who.apply('plan', { ops: [{ op: 'remove_node', id }] });
      } else if (roll === 5) {
        const source = nodes[pick(nodes.length)] as string;
        const target = nodes[pick(nodes.length)] as string;
        const op: Op = { op: 'add_edge', edge: { type: 'relates_to', source, target } };
        const result = await who.apply('plan', { ops: [op] });
        if (result.status === 'invalid') continue;
      } else if (roll === 6) {
        await who.comment('plan', {
          body: `Comment ${i}`,
          ...(pick(2) === 0 ? { nodeId: nodes[0] as string } : {}),
        });
      } else if (roll === 7) {
        const result = await ada.undo('plan', { actorId: who.actor.id, scope: 'last' });
        if (result.undone.length === 0) continue;
      } else {
        await ada.layout('plan', { scope: 'all' });
      }
      await record();
    }
    // Several batches can leave the cursor where it was (nothing changed); keep the last state per cursor.
    const byCursor = new Map(recorded.map((r) => [r.cursor, r.text]));
    expect(byCursor.size).toBeGreaterThan(20);
    for (const [cursor, text] of byCursor) {
      expect(serializeBoard(await ada.snapshotAt('plan', cursor)), `cursor ${cursor}`).toBe(text);
    }
    expect((await ada.history('plan')).earliest).toBe(0);

    // The steps survive a restart.
    await server.close();
    server = await startTestServer(root);
    for (const [cursor, text] of byCursor) {
      expect(serializeBoard(await server.api(ADA).snapshotAt('plan', cursor))).toBe(text);
    }
  });

  it('says how far back history reaches', async () => {
    await server.api(BOT).apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'One' } }],
    });
    await server.close();
    await rm(path.join(projectPaths(root).local, 'plan.history.jsonl'));
    server = await startTestServer(root);
    const api = server.api(ADA);
    const current = (await api.outline('plan')).cursor;
    expect((await api.history('plan')).earliest).toBe(current);
    try {
      await api.snapshotAt('plan', 0);
      throw new Error('expected not_found');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenBoardError);
      expect((error as OpenBoardError).code).toBe('not_found');
      expect((error as OpenBoardError).message).toContain(
        `earliest cursor available is ${current}`,
      );
    }
    expect((await api.snapshotAt('plan', current)).nodes).toEqual(
      (await api.getBoard('plan')).nodes,
    );
  });

  it('serves snapshots over HTTP', async () => {
    const res = await api(server, 'GET', '/api/boards/plan/at/0');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: 'plan', nodes: {} });
    expect((await api(server, 'GET', '/api/boards/plan/at/x')).status).toBe(400);
    expect((await api(server, 'GET', '/api/boards/plan/at/999')).status).toBe(400);
  });
});

describe('document lineage', () => {
  function providerFor(ydoc: Y.Doc, lineage: string) {
    return new WebsocketProvider(`${server.url.replace('http', 'ws')}/sync`, 'plan', ydoc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      params: { lineage, actorId: 'ada', actorName: 'Ada', actorKind: 'human' },
      disableBc: true,
    });
  }

  function closeCode(url: string): Promise<number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });
  }

  it('is listed, kept across restarts, and required to sync', async () => {
    const lineage = await lineageOf(server, 'plan');
    const listing = await api(server, 'GET', '/api/boards');
    expect(listing.json[0].lineage).toBe(lineage);
    await server.close();
    server = await startTestServer(root);
    expect(await lineageOf(server, 'plan')).toBe(lineage);
    const base = `${server.url.replace('http', 'ws')}/sync/plan`;
    expect(await closeCode(base)).toBe(CLOSE_STALE_DOCUMENT);
    expect(await closeCode(`${base}?lineage=l_other`)).toBe(CLOSE_STALE_DOCUMENT);
  });

  it('keeps a tab holding an older document from merging it into a rebuilt board', async () => {
    // A tab syncs the board and then loses its connection.
    const oldLineage = await lineageOf(server, 'plan');
    await server.api(ADA).apply('plan', {
      ops: [{ op: 'add_node', id: 'n_old', node: { type: 'note', title: 'Old' } }],
    });
    const ydoc = new Y.Doc();
    const tab = providerFor(ydoc, oldLineage);
    await waitFor(() => tab.synced, { what: 'the tab to sync' });
    tab.disconnect();

    // The runtime state is wiped and the board file now holds another board with the same id,
    // served again on the same port.
    const port = server.info.port;
    await server.close();
    await rm(projectPaths(root).local, { recursive: true, force: true });
    const other = BoardDoc.create({ id: 'plan', name: 'Another plan' });
    await writeFile(projectPaths(root).boardFile('plan'), serializeBoard(other.toJSON()));
    server = await startTestServer(root, { port });
    expect(server.info.port).toBe(port);
    const newLineage = await lineageOf(server, 'plan');
    expect(newLineage).not.toBe(oldLineage);

    // The stale tab edits and reconnects with what it believes is the lineage.
    BoardDoc.fromYDoc(ydoc).apply(
      [{ op: 'add_node', id: 'n_stale', node: { type: 'note', title: 'Stale edit' } }],
      { actor: ADA, source: 'ui' },
    );
    const closes: number[] = [];
    tab.on('connection-close', (event: CloseEvent | null) => {
      if (event) closes.push(event.code);
    });
    tab.connect();
    await waitFor(() => closes.includes(CLOSE_STALE_DOCUMENT), {
      what: 'the stale tab to be refused',
    });
    tab.destroy();
    await sleep(50);
    const board = await server.api(ADA).getBoard('plan');
    expect(board.name).toBe('Another plan');
    expect(Object.keys(board.nodes)).toEqual([]);

    // A fresh tab with the new lineage syncs normally.
    const fresh = providerFor(new Y.Doc(), newLineage);
    await waitFor(() => fresh.synced, { what: 'the fresh tab to sync' });
    fresh.destroy();
  });
});

describe('the live channel in a browser', () => {
  it('carries agent presence and the session list over awareness', async () => {
    const lineage = await lineageOf(server, 'plan');
    const ydoc = new Y.Doc();
    const tab = new WebsocketProvider(`${server.url.replace('http', 'ws')}/sync`, 'plan', ydoc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      params: { lineage, actorId: 'ada', actorName: 'Ada', actorKind: 'human' },
      disableBc: true,
    });
    try {
      await waitFor(() => tab.synced, { what: 'the tab to sync' });
      // `any`: awareness states are untyped peer data; the test inspects them field by field.
      const states = () => [...tab.awareness.getStates().values()] as Array<Record<string, any>>;
      // Present from the start: the (empty) session list.
      await waitFor(() => states().some((s) => s.live), { what: 'the session list' });

      const bot = server.api(BOT, { session: 'main' });
      await bot.reportActivity({ session: 'main', kind: 'session_start', label: 'Release' });
      await bot.reportActivity({
        session: 'main',
        kind: 'tool_start',
        tool: 'Bash',
        summary: 'pnpm build',
      });
      const live = await waitFor(() => states().find((s) => s.live?.sessions?.[0]?.current)?.live, {
        what: 'the session to arrive',
      });
      expect(live.sessions[0]).toMatchObject({ id: 'main', label: 'Release', status: 'active' });
      expect(states().find((s) => s.live)?.actor).toMatchObject({ id: 'system', kind: 'system' });
      // The tab has the board open, so the agent's work shows there.
      const agent = await waitFor(
        () => states().find((s) => s.actor?.id === 'bot' && s.agent)?.agent,
        {
          what: 'the agent presence',
        },
      );
      expect(agent).toMatchObject({
        status: 'working',
        session: 'main',
        detail: 'Bash: pnpm build',
      });

      await bot.read('plan');
      await waitFor(
        () => states().find((s) => s.actor?.id === 'bot' && s.agent?.status === 'reading'),
        {
          what: 'the presence to follow the read',
        },
      );
    } finally {
      tab.destroy();
    }
  });
});
