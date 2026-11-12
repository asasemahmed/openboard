import { readFile, writeFile } from 'node:fs/promises';
import {
  type Actor,
  type BoardApi,
  BoardDoc,
  FRAME_POLICY_PROP,
  OpenBoardError,
  parseBoard,
  serializeBoard,
} from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { projectPaths } from './paths.js';
import { lineageOf, removeRoot, sleep, startTestServer, tempRoot, waitFor } from './testing.js';
import type { OpenBoardServer } from './types.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const BOT: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };
const OTHER: Actor = { id: 'other', kind: 'agent', name: 'Other' };

let root: string;
let server: OpenBoardServer;
const providers: WebsocketProvider[] = [];
let lineage = '';

const ada = () => server.api(ADA);
const bot = () => server.api(BOT);
const other = () => server.api(OTHER);

async function failure(promise: Promise<unknown>): Promise<OpenBoardError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenBoardError);
    return error as OpenBoardError;
  }
  throw new Error('expected the call to fail');
}

/** Ada makes two notes (h1, h2) and a frame (f). */
async function seed(): Promise<void> {
  const result = await ada().apply('plan', {
    ops: [
      { op: 'add_node', id: 'h1', node: { type: 'task', title: 'Payment API', status: 'todo' } },
      { op: 'add_node', id: 'h2', node: { type: 'note', title: 'Ada note' } },
      { op: 'add_node', id: 'f', node: { type: 'frame', title: 'Area' } },
    ],
  });
  expect(result.status).toBe('applied');
}

async function restart(): Promise<void> {
  await server.close();
  server = await startTestServer(root);
}

function connect(actor: Actor) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(`${server.url.replace('http', 'ws')}/sync`, 'plan', ydoc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    params: { lineage, actorId: actor.id, actorName: actor.name, actorKind: actor.kind },
    disableBc: true,
  });
  providers.push(provider);
  const synced = new Promise<void>((resolve) => {
    if (provider.synced) resolve();
    else provider.once('sync', () => resolve());
  });
  return { synced, doc: BoardDoc.fromYDoc(ydoc) };
}

beforeEach(async () => {
  root = await tempRoot();
  server = await startTestServer(root);
  await ada().createBoard({ name: 'Plan' });
  lineage = await lineageOf(server, 'plan');
  await seed();
});

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await server.close();
  await removeRoot(root);
});

// ── Policy in apply ──────────────────────────────────────────────────────────

describe('apply under the review policy', () => {
  it('applies a batch that only adds, and its own follow-up edits', async () => {
    const added = await bot().apply('plan', {
      ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'Bot note' } }],
    });
    expect(added.status).toBe('applied');
    const id = added.refs.n as string;
    const edited = await bot().apply('plan', {
      ops: [{ op: 'update_node', id, patch: { body: 'more' } }],
    });
    expect(edited.status).toBe('applied');
    expect(edited.review).toBeUndefined();
  });

  it('proposes a batch that changes a person’s work, changing nothing yet', async () => {
    const before = await ada().getBoard('plan');
    const result = await bot().apply('plan', {
      reason: 'Finish payments',
      ops: [
        { op: 'add_node', ref: 'q', node: { type: 'question', title: 'Who?' } },
        { op: 'update_node', id: 'h1', patch: { status: 'done' } },
        { op: 'add_edge', edge: { type: 'blocks', source: '$q', target: 'h1' } },
      ],
    });
    expect(result.status).toBe('proposed');
    expect(result.review?.indexes).toEqual([1]);
    expect(result.review?.why).toBe('Op 1 changes "Payment API", which Ada created.');
    expect(result.refs.q).toMatch(/^n_/);
    expect(result.cursor).toBe(before && (await ada().changes('plan', { since: 0 })).cursor);
    // Nothing changed but the actor registry, which now names the proposer.
    const after = await ada().getBoard('plan');
    expect(after.nodes).toEqual(before.nodes);
    expect(after.edges).toEqual(before.edges);
    expect(after.actors).toEqual({ ...before.actors, bot: BOT });

    const { proposals } = await ada().proposals('plan');
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal?.id).toBe(result.proposalId);
    expect(proposal?.reason).toBe('Finish payments');
    expect(proposal?.items.map((i) => i.needsReview)).toEqual([false, true, false]);
    // The ghost of the new node has a place on the canvas.
    expect(proposal?.preview.nodes[result.refs.q as string]?.view).toBeDefined();
  });

  it('refuses a batch the policy denies, and changes nothing', async () => {
    await ada().apply('plan', {
      ops: [{ op: 'update_node', id: 'f', patch: { props: { [FRAME_POLICY_PROP]: 'locked' } } }],
    });
    const before = await ada().getBoard('plan');
    const result = await bot().apply('plan', {
      ops: [
        { op: 'add_node', node: { type: 'note', title: 'Fine' } },
        { op: 'add_node', node: { type: 'note', title: 'Inside', parent: 'f' } },
      ],
    });
    expect(result.status).toBe('invalid');
    expect(result.errors).toEqual([
      {
        index: 1,
        code: 'forbidden',
        message: expect.stringContaining('locked frame "Area"'),
      },
    ]);
    expect(await ada().getBoard('plan')).toEqual(before);
    expect((await ada().proposals('plan')).proposals).toEqual([]);
  });

  it('still reports an invalid batch as invalid, before the policy', async () => {
    const result = await bot().apply('plan', {
      ops: [{ op: 'update_node', id: 'missing', patch: { title: 'x' } }],
    });
    expect(result.status).toBe('invalid');
    expect(result.errors?.[0]?.code).toBe('not_found');
  });

  it('reports in a dry run that a batch would be proposed', async () => {
    const result = await bot().apply('plan', {
      dryRun: true,
      ops: [{ op: 'remove_node', id: 'h2' }],
    });
    expect(result.status).toBe('valid');
    expect(result.review?.indexes).toEqual([0]);
    expect((await ada().proposals('plan')).proposals).toEqual([]);
  });

  it('never restricts people', async () => {
    await ada().setConfig({ version: 1, policy: { default: 'locked', agents: {} } });
    const result = await ada().apply('plan', { ops: [{ op: 'remove_node', id: 'h2' }] });
    expect(result.status).toBe('applied');
    const refused = await bot().apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'x' } }],
    });
    expect(refused.errors?.[0]?.message).toContain('this agent is locked');
  });
});

// ── Proposals ────────────────────────────────────────────────────────────────

async function propose(api: BoardApi = bot()) {
  const result = await api.apply('plan', {
    reason: 'Tidy up',
    ops: [
      { op: 'add_node', ref: 'q', node: { type: 'question', title: 'Who owns it?' } },
      { op: 'update_node', id: 'h1', patch: { status: 'done' } },
      { op: 'add_edge', edge: { type: 'blocks', source: '$q', target: 'h1' } },
      { op: 'remove_node', id: 'h2' },
    ],
  });
  expect(result.status).toBe('proposed');
  return result;
}

describe('proposals', () => {
  it('accepting applies everything as one batch by the author, and tells the author', async () => {
    const result = await propose();
    const decided = await ada().decideProposal('plan', result.proposalId as string, {
      action: 'accept',
      note: 'Thanks, looks right',
    });
    expect(decided.status).toBe('accepted');
    expect(decided.decidedBy).toBe('ada');
    expect(decided.items.every((i) => i.status === 'accepted')).toBe(true);

    const board = await ada().getBoard('plan');
    const q = board.nodes[result.refs.q as string];
    expect(q).toMatchObject({ createdBy: 'bot', updatedBy: 'bot' });
    expect(q?.view).toBeDefined();
    expect(board.nodes.h1).toMatchObject({ status: 'done', updatedBy: 'bot' });
    expect(board.nodes.h2).toBeUndefined();

    const { batches } = await ada().history('plan');
    expect(batches[0]).toMatchObject({
      actor: 'bot',
      source: 'ops',
      proposalId: result.proposalId,
      reason: 'Tidy up',
    });

    const inbox = await bot().inbox('plan');
    expect(inbox.items).toEqual([
      expect.objectContaining({
        kind: 'decision',
        from: 'ada',
        proposalId: result.proposalId,
        body: 'Thanks, looks right',
        batchId: batches[0]?.id,
      }),
    ]);
    expect(inbox.items[0]?.summary).toContain('accepted #0, #1, #2, #3');
    expect(inbox.text).toContain('| Thanks, looks right');
  });

  it('accepts a subset together with what it depends on', async () => {
    const result = await propose();
    const decided = await ada().decideProposal('plan', result.proposalId as string, {
      action: 'accept',
      items: [2],
    });
    expect(decided.items.map((i) => i.status)).toEqual([
      'accepted',
      'pending',
      'accepted',
      'pending',
    ]);
    expect(decided.status).toBe('pending');
    const board = await ada().getBoard('plan');
    expect(board.nodes[result.refs.q as string]).toBeDefined();
    expect(board.nodes.h1?.status).toBe('todo');
    // The rest can still be decided, and the preview shows only what is left.
    expect(decided.preview.updated).toEqual({ h1: { fields: ['status'] } });
    const rest = await ada().decideProposal('plan', decided.id, { action: 'reject' });
    expect(rest.status).toBe('partly_accepted');
  });

  it('rejects with a note, and rejecting an item rejects what depends on it', async () => {
    const result = await propose();
    const decided = await ada().decideProposal('plan', result.proposalId as string, {
      action: 'reject',
      items: [0],
      note: 'No question needed',
    });
    expect(decided.items.map((i) => i.status)).toEqual([
      'rejected',
      'pending',
      'rejected',
      'pending',
    ]);
    const final = await ada().decideProposal('plan', decided.id, { action: 'reject' });
    expect(final.status).toBe('rejected');
    expect(final.note).toBe('No question needed');
    const inbox = await bot().inbox('plan');
    expect(inbox.items.map((i) => i.kind)).toEqual(['decision', 'decision']);
    expect(inbox.items[0]?.body).toBe('No question needed');
  });

  it('turns items whose target changed into conflicts and applies the rest', async () => {
    const result = await propose();
    await ada().apply('plan', {
      ops: [{ op: 'update_node', id: 'h1', patch: { title: 'Payments' } }],
    });
    const decided = await ada().decideProposal('plan', result.proposalId as string, {
      action: 'accept',
    });
    expect(decided.status).toBe('partly_accepted');
    const statuses = Object.fromEntries(decided.items.map((i) => [i.index, i.status]));
    expect(statuses).toEqual({ 0: 'accepted', 1: 'conflict', 2: 'accepted', 3: 'accepted' });
    expect(decided.items[1]?.conflict).toBe(
      '"Payments" was changed by Ada after this was proposed',
    );
    const board = await ada().getBoard('plan');
    expect(board.nodes.h1?.status).toBe('todo');
    expect(board.nodes.h2).toBeUndefined();
  });

  it('flags a pending item as a conflict as soon as its target vanishes', async () => {
    const result = await propose();
    await ada().apply('plan', { ops: [{ op: 'remove_node', id: 'h1' }] });
    const proposal = await waitFor(
      async () => {
        const [p] = (await ada().proposals('plan')).proposals;
        return p?.items[1]?.status === 'conflict' ? p : null;
      },
      { what: 'the proposal to be re-checked' },
    );
    expect(proposal.items.map((i) => i.status)).toEqual([
      'pending',
      'conflict',
      'conflict',
      'pending',
    ]);
    expect(proposal.items[1]?.conflict).toBe('h1 was removed after this was proposed');
    // The preview no longer shows what would fail.
    expect(Object.keys(proposal.preview.edges)).toEqual([]);
    expect(proposal.preview.removedNodes).toEqual(['h2']);
    expect(result.proposalId).toBe(proposal.id);
  });

  it('lets the author withdraw, and nobody else', async () => {
    const result = await propose();
    const id = result.proposalId as string;
    expect((await failure(other().withdrawProposal('plan', id))).code).toBe('forbidden');
    expect((await failure(ada().withdrawProposal('plan', id))).code).toBe('forbidden');
    const withdrawn = await bot().withdrawProposal('plan', id);
    expect(withdrawn.status).toBe('withdrawn');
    expect((await failure(bot().withdrawProposal('plan', id))).code).toBe('conflict');
    expect((await ada().proposals('plan')).proposals).toEqual([]);
    expect((await ada().proposals('plan', { status: 'all' })).proposals).toHaveLength(1);
  });

  it('only lets people decide', async () => {
    const result = await propose();
    const id = result.proposalId as string;
    expect((await failure(bot().decideProposal('plan', id, { action: 'accept' }))).code).toBe(
      'forbidden',
    );
    expect((await failure(other().decideProposal('plan', id, { action: 'accept' }))).code).toBe(
      'forbidden',
    );
    expect((await failure(ada().decideProposal('plan', 'p_nope', { action: 'accept' }))).code).toBe(
      'not_found',
    );
    expect(
      (await failure(ada().decideProposal('plan', id, { action: 'accept', items: [9] }))).code,
    ).toBe('invalid_request');
    await ada().decideProposal('plan', id, { action: 'reject' });
    expect((await failure(ada().decideProposal('plan', id, { action: 'accept' }))).code).toBe(
      'conflict',
    );
  });

  it('keeps pending proposals across a restart and out of the board file', async () => {
    const result = await propose();
    await restart();
    const { proposals } = await ada().proposals('plan');
    expect(proposals.map((p) => p.id)).toEqual([result.proposalId]);
    const text = await readFile(projectPaths(root).boardFile('plan'), 'utf8');
    expect(text).not.toContain(result.proposalId);
    expect(text).not.toContain('Who owns it?');
    const decided = await ada().decideProposal('plan', result.proposalId as string, {
      action: 'accept',
    });
    expect(decided.status).toBe('accepted');
  });

  it('renders proposals for a model', async () => {
    await propose();
    const { text } = await ada().proposals('plan');
    expect(text).toContain('by Bot (agent)');
    expect(text).toContain('#1 [review] Update "Payment API": status todo → done');
    expect(text).toContain('#2 [free] Connect "Who owns it?" blocks "Payment API" (needs #0)');
  });
});

// ── History and undo ─────────────────────────────────────────────────────────

describe('history and undo', () => {
  beforeEach(async () => {
    await ada().setConfig({ version: 1, policy: { default: 'auto', agents: {} } });
  });

  it('records batches with reasons, and links changes to them', async () => {
    const result = await bot().apply('plan', {
      reason: 'Because',
      ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'N' } }],
    });
    const { batches, text } = await ada().history('plan');
    expect(batches[0]).toMatchObject({
      actor: 'bot',
      reason: 'Because',
      summary: 'Added 1 node',
      nodeIds: [result.refs.n],
      cursor: result.cursor,
    });
    expect(text).toContain('reason "Because"');
    const changes = await ada().changes('plan', { since: 0 });
    const added = changes.changes.find((c) => c.id === result.refs.n);
    expect(added).toMatchObject({ reason: 'Because', batchId: batches[0]?.id });
    // Layout runs and pure moves are left out unless asked for.
    const withMoves = await ada().history('plan', { includeMoves: true });
    expect(withMoves.batches.length).toBeGreaterThanOrEqual(batches.length);
  });

  it('restores exactly, bookkeeping included', async () => {
    const original = (await ada().getBoard('plan')).nodes.h1;
    await bot().apply('plan', {
      ops: [{ op: 'update_node', id: 'h1', patch: { status: 'done', body: 'agent' } }],
    });
    const [batch] = (await ada().history('plan', { actor: 'bot' })).batches;
    const undone = await ada().undo('plan', { batchId: batch?.id as string });
    expect(undone.undone).toEqual([batch?.id]);
    expect(undone.conflicts).toEqual([]);
    expect((await ada().getBoard('plan')).nodes.h1).toEqual(original);

    const { batches } = await ada().history('plan');
    expect(batches[0]).toMatchObject({ source: 'undo', undoes: batch?.id, actor: 'ada' });
    expect(batches[1]).toMatchObject({ id: batch?.id, undoneBy: batches[0]?.id });
    const inbox = await bot().inbox('plan');
    expect(inbox.items).toEqual([
      expect.objectContaining({ kind: 'undone', from: 'ada', batchId: batch?.id }),
    ]);
  });

  it('removes added nodes with their layout, and leaves what changed later', async () => {
    const result = await bot().apply('plan', {
      ops: [
        { op: 'add_node', ref: 'a', node: { type: 'note', title: 'A' } },
        { op: 'add_node', ref: 'b', node: { type: 'note', title: 'B' } },
        { op: 'add_edge', edge: { type: 'relates_to', source: '$a', target: '$b' } },
      ],
    });
    const a = result.refs.a as string;
    const b = result.refs.b as string;
    await ada().apply('plan', {
      ops: [{ op: 'update_node', id: b, patch: { title: 'B by Ada' } }],
    });
    const undone = await bot().undo('plan', { actorId: 'bot', scope: 'last' });
    expect(undone.conflicts).toEqual([
      { kind: 'node', id: b, reason: 'changed by Ada after this batch' },
    ]);
    expect(undone.text).toContain(`node ${b} "B by Ada": changed by Ada after this batch`);
    const board = await ada().getBoard('plan');
    expect(board.nodes[a]).toBeUndefined();
    expect(board.nodes[b]?.title).toBe('B by Ada');
    expect(Object.keys(board.edges)).toEqual([]);
  });

  it('keeps a node that something added later still points at', async () => {
    const result = await bot().apply('plan', {
      ops: [{ op: 'add_node', ref: 'a', node: { type: 'note', title: 'A' } }],
    });
    const a = result.refs.a as string;
    await ada().apply('plan', {
      ops: [{ op: 'add_edge', id: 'e_ada', edge: { type: 'relates_to', source: 'h2', target: a } }],
    });
    const undone = await ada().undo('plan', { actorId: 'bot', scope: 'last' });
    expect(undone.undone).toEqual([]);
    expect(undone.conflicts[0]?.reason).toContain('edge e_ada');
    expect((await ada().getBoard('plan')).nodes[a]).toBeDefined();
  });

  it('redoes when an undo is undone', async () => {
    await bot().apply('plan', { ops: [{ op: 'update_node', id: 'h2', patch: { title: 'New' } }] });
    const after = (await ada().getBoard('plan')).nodes.h2;
    const first = await bot().undo('plan', { actorId: 'bot', scope: 'last' });
    expect((await ada().getBoard('plan')).nodes.h2?.title).toBe('Ada note');
    const [undoBatch] = (await ada().history('plan')).batches;
    const redo = await bot().undo('plan', { batchId: undoBatch?.id as string });
    expect(redo.undone).toEqual([undoBatch?.id]);
    expect((await ada().getBoard('plan')).nodes.h2).toEqual(after);
    // The original is in place again, so it can be undone again.
    const again = await bot().undo('plan', { batchId: first.undone[0] as string });
    expect(again.undone).toEqual(first.undone);
  });

  it('lets an agent undo only its own batches', async () => {
    await other().apply('plan', { ops: [{ op: 'add_node', node: { type: 'note', title: 'O' } }] });
    const [batch] = (await ada().history('plan', { actor: 'other' })).batches;
    expect((await failure(bot().undo('plan', { batchId: batch?.id as string }))).code).toBe(
      'forbidden',
    );
    expect((await failure(bot().undo('plan', { actorId: 'other', scope: 'all' }))).code).toBe(
      'forbidden',
    );
    const [seed] = (await ada().history('plan', { actor: 'ada' })).batches;
    expect((await failure(bot().undo('plan', { batchId: seed?.id as string }))).code).toBe(
      'forbidden',
    );
    expect((await failure(ada().undo('plan', { batchId: 'b_nope' }))).code).toBe('not_found');
    const own = await other().undo('plan', { batchId: batch?.id as string });
    expect(own.undone).toEqual([batch?.id]);
    expect((await failure(other().undo('plan', { batchId: batch?.id as string }))).code).toBe(
      'conflict',
    );
  });

  it('undoes everything an actor did with scope "all"', async () => {
    for (const title of ['One', 'Two', 'Three']) {
      await bot().apply('plan', { ops: [{ op: 'add_node', node: { type: 'note', title } }] });
    }
    const result = await ada().undo('plan', { actorId: 'bot', scope: 'all' });
    expect(result.undone).toHaveLength(3);
    const titles = Object.values((await ada().getBoard('plan')).nodes).map((n) => n.title);
    expect(titles.sort()).toEqual(['Ada note', 'Area', 'Payment API']);
    expect((await ada().history('plan', { actor: 'bot' })).batches.every((b) => b.undoneBy)).toBe(
      true,
    );
  });

  it('coalesces a person’s browser edits into one batch', async () => {
    const alice = connect(ADA);
    await alice.synced;
    for (const title of ['One', 'Two', 'Three']) {
      alice.doc.apply([{ op: 'add_node', node: { type: 'note', title } }], {
        actor: ADA,
        source: 'ui',
      });
    }
    await waitFor(async () => Object.keys((await ada().getBoard('plan')).nodes).length === 6, {
      what: 'the edits to arrive',
    });
    const { batches } = await ada().history('plan');
    expect(batches[0]).toMatchObject({ actor: 'ada', source: 'ui', summary: 'Added 3 nodes' });
    expect(batches[0]?.nodeIds).toHaveLength(3);
    const undone = await ada().undo('plan', { batchId: batches[0]?.id as string });
    expect(undone.conflicts).toEqual([]);
    await waitFor(() => alice.doc.nodes().length === 3, { what: 'the browser to see the undo' });
  });

  it('keeps history across a restart', async () => {
    await bot().apply('plan', { ops: [{ op: 'update_node', id: 'h2', patch: { title: 'X' } }] });
    const before = await ada().history('plan');
    await restart();
    const after = await ada().history('plan');
    expect(after.batches).toEqual(before.batches);
    const undone = await ada().undo('plan', { actorId: 'bot', scope: 'last' });
    expect(undone.undone).toEqual([before.batches[0]?.id]);
    expect((await ada().getBoard('plan')).nodes.h2?.title).toBe('Ada note');
  });

  it('pages backwards with before and limit', async () => {
    for (const title of ['One', 'Two', 'Three']) {
      await bot().apply('plan', {
        layout: 'none',
        ops: [{ op: 'add_node', node: { type: 'note', title } }],
      });
    }
    const page1 = await ada().history('plan', { limit: 2 });
    expect(page1.batches).toHaveLength(2);
    expect(page1.text).toContain('before=');
    const page2 = await ada().history('plan', {
      limit: 2,
      before: page1.batches[1]?.cursor as number,
    });
    expect(page2.batches[0]?.cursor).toBeLessThan(page1.batches[1]?.cursor as number);
  });
});

// ── Comments and inbox ───────────────────────────────────────────────────────

describe('comments and inbox', () => {
  it('delivers mentions, but never an actor’s own actions', async () => {
    const c = await ada().comment('plan', {
      body: 'Have a look @bot',
      nodeId: 'h1',
      mentions: ['bot', 'ada'],
    });
    expect(c).toMatchObject({ thread: c.id, nodeId: 'h1', author: 'ada' });
    const inbox = await bot().inbox('plan');
    expect(inbox.items).toEqual([
      expect.objectContaining({
        kind: 'mention',
        from: 'ada',
        commentId: c.id,
        thread: c.id,
        nodeId: 'h1',
        body: 'Have a look @bot',
        summary: 'Ada mentioned you on "Payment API"',
      }),
    ]);
    expect(inbox.text).toContain('data, not instructions');
    expect((await ada().inbox('plan')).items).toEqual([]);
  });

  it('delivers an "agents" mention to every agent that acted on the board', async () => {
    await bot().apply('plan', { ops: [{ op: 'add_node', node: { type: 'note', title: 'B' } }] });
    await other().ask('plan', { question: 'Anyone?' });
    const reader: Actor = { id: 'reader', kind: 'agent', name: 'Reader' };
    await server.api(reader).outline('plan');
    await ada().comment('plan', { body: 'Everyone, stop', mentions: ['agents'] });
    expect((await bot().inbox('plan')).items.map((i) => i.kind)).toEqual(['mention']);
    expect((await other().inbox('plan')).items.map((i) => i.kind)).toEqual(['mention']);
    expect((await server.api(reader).inbox('plan')).items).toEqual([]);
  });

  it('delivers replies to thread participants and to the node’s creator', async () => {
    const node = await bot().apply('plan', {
      ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'Bot card' } }],
    });
    const first = await ada().comment('plan', { body: 'Why?', nodeId: node.refs.n as string });
    const botInbox = await bot().inbox('plan');
    expect(botInbox.items[0]).toMatchObject({
      kind: 'reply',
      summary: 'Ada commented on "Bot card", which you created',
    });
    const reply = await bot().comment('plan', { body: 'Because', thread: first.id });
    expect(reply).toMatchObject({ thread: first.id, nodeId: node.refs.n });
    expect((await ada().inbox('plan')).items).toEqual([
      expect.objectContaining({ kind: 'reply', commentId: reply.id }),
    ]);
    await ada().comment('plan', { body: 'OK', thread: reply.id });
    expect((await bot().inbox('plan')).items.map((i) => i.body)).toEqual(['OK']);
    expect((await failure(ada().comment('plan', { body: 'x', thread: 'c_nope' }))).code).toBe(
      'not_found',
    );
    expect((await failure(ada().comment('plan', { body: 'x', nodeId: 'nope' }))).code).toBe(
      'not_found',
    );
  });

  it('marks items seen, unless peeking, and re-reads from a position', async () => {
    await ada().comment('plan', { body: 'One', mentions: ['bot'] });
    const peek = await bot().inbox('plan', { peek: true });
    expect(peek.items).toHaveLength(1);
    const read = await bot().inbox('plan');
    expect(read.items).toHaveLength(1);
    expect((await bot().inbox('plan')).items).toEqual([]);
    await ada().comment('plan', { body: 'Two', mentions: ['bot'] });
    expect((await bot().inbox('plan', { since: 0 })).items.map((i) => i.body)).toEqual([
      'One',
      'Two',
    ]);
    expect((await bot().inbox('plan', { since: read.position })).items.map((i) => i.body)).toEqual([
      'Two',
    ]);
  });

  it('keeps the inbox and seen positions across a restart', async () => {
    await ada().comment('plan', { body: 'One', mentions: ['bot'] });
    await bot().inbox('plan');
    await ada().comment('plan', { body: 'Two', mentions: ['bot'] });
    await restart();
    expect((await bot().inbox('plan')).items.map((i) => i.body)).toEqual(['Two']);
    await ada().comment('plan', { body: 'Three', mentions: ['bot'] });
    const next = await bot().inbox('plan');
    expect(next.items.map((i) => i.body)).toEqual(['Three']);
    expect(next.items[0]?.seq).toBeGreaterThan(2);
  });

  it('saves comments in the board file and reconciles them from it', async () => {
    const c = await ada().comment('plan', { body: 'Saved', nodeId: 'h2' });
    const file = projectPaths(root).boardFile('plan');
    await waitFor(async () => (await readFile(file, 'utf8')).includes('"Saved"'), {
      what: 'the save',
    });
    const board = parseBoard(await readFile(file, 'utf8'));
    expect(board.comments?.[c.id]).toEqual(c);

    // A teammate's comment arrives with a checkout.
    board.comments = {
      ...board.comments,
      c_pulled: {
        id: 'c_pulled',
        thread: 'c_pulled',
        author: 'ada',
        body: 'From git @bot',
        createdAt: new Date().toISOString(),
        mentions: ['bot'],
      },
    };
    await writeFile(file, serializeBoard(board));
    await waitFor(async () => (await ada().getBoard('plan')).comments?.c_pulled, {
      what: 'the reload',
    });
    expect((await bot().inbox('plan')).items.map((i) => i.commentId)).toEqual(['c_pulled']);
  });

  it('turns comments written straight into a synced document into inbox items', async () => {
    const browser = connect(ADA);
    await browser.synced;
    const now = new Date().toISOString();
    browser.doc.putComment(
      {
        id: 'c_web',
        thread: 'c_web',
        author: 'ada',
        body: 'From the canvas',
        createdAt: now,
        mentions: ['bot'],
      },
      browser.doc.origin('ada', 'ui'),
      { actor: ADA },
    );
    const inbox = await waitFor(
      async () => {
        const result = await bot().inbox('plan', { peek: true });
        return result.items.length > 0 ? result : null;
      },
      { what: 'the comment to arrive' },
    );
    expect(inbox.items[0]).toMatchObject({ kind: 'mention', commentId: 'c_web', from: 'ada' });
    const [batch] = (await ada().history('plan')).batches;
    expect(batch).toMatchObject({ actor: 'ada', source: 'ui', commentIds: ['c_web'] });
  });

  it('resolves and reopens threads', async () => {
    const c = await ada().comment('plan', { body: 'Done?' });
    const reply = await bot().comment('plan', { body: 'Yes', thread: c.id });
    const resolved = await bot().resolveThread('plan', reply.id);
    expect(resolved).toMatchObject({ id: c.id, resolvedBy: 'bot' });
    const reopened = await ada().resolveThread('plan', c.id, false);
    expect(reopened.resolvedAt).toBeUndefined();
  });
});

// ── Questions ────────────────────────────────────────────────────────────────

describe('questions', () => {
  it('long-polls until a person answers', async () => {
    const ask = await bot().ask('plan', {
      kind: 'approval',
      question: 'May I delete the old notes?',
      options: ['yes', 'no'],
      nodeIds: ['h2'],
    });
    expect(ask).toMatchObject({ status: 'open', author: 'bot', nodeIds: ['h2'] });
    const started = Date.now();
    const waiting = bot().askResult('plan', ask.id, { waitMs: 10_000 });
    await sleep(50);
    await ada().answerAsk('plan', ask.id, { option: 'no', text: 'Keep them' });
    const answered = await waiting;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(answered).toMatchObject({
      status: 'answered',
      answer: { by: 'ada', option: 'no', text: 'Keep them' },
    });
    // The long-poll delivered the answer; the inbox does not deliver it again,
    // but keeps it for a re-read.
    expect((await bot().inbox('plan')).items).toEqual([]);
    expect((await bot().inbox('plan', { since: 0 })).items).toEqual([
      expect.objectContaining({ kind: 'answer', askId: ask.id, body: 'no — Keep them' }),
    ]);
  });

  it('returns the open question when the wait is over', async () => {
    const ask = await bot().ask('plan', { question: 'Anyone?' });
    const started = Date.now();
    const result = await bot().askResult('plan', ask.id, { waitMs: 150 });
    expect(result.status).toBe('open');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect((await bot().inbox('plan')).openAsks).toBe(1);
  });

  it('lets the first answer win and only people answer', async () => {
    const ask = await bot().ask('plan', { question: 'Which?', options: ['a', 'b'] });
    expect((await failure(bot().answerAsk('plan', ask.id, { option: 'a' }))).code).toBe(
      'forbidden',
    );
    expect((await failure(ada().answerAsk('plan', ask.id, { option: 'c' }))).code).toBe(
      'invalid_request',
    );
    await ada().answerAsk('plan', ask.id, { option: 'a' });
    expect((await failure(ada().answerAsk('plan', ask.id, { text: 'b' }))).code).toBe('conflict');
    expect((await failure(ada().answerAsk('plan', 'a_nope', { text: 'b' }))).code).toBe(
      'not_found',
    );
  });

  it('can be cancelled by its author or a person, and wakes waiters', async () => {
    const ask = await bot().ask('plan', { question: 'Q1' });
    expect((await failure(other().cancelAsk('plan', ask.id))).code).toBe('forbidden');
    const waiting = bot().askResult('plan', ask.id, { waitMs: 10_000 });
    await sleep(20);
    await bot().cancelAsk('plan', ask.id);
    expect((await waiting).status).toBe('cancelled');
    const second = await bot().ask('plan', { question: 'Q2' });
    expect((await ada().cancelAsk('plan', second.id)).status).toBe('cancelled');
    expect((await failure(ada().cancelAsk('plan', second.id))).code).toBe('conflict');
  });

  it('releases waiters when the server closes', async () => {
    const ask = await bot().ask('plan', { question: 'Q' });
    const waiting = bot().askResult('plan', ask.id, { waitMs: 60_000 });
    await sleep(20);
    const started = Date.now();
    await server.close();
    const result = await waiting;
    expect(result.status).toBe('open');
    expect(Date.now() - started).toBeLessThan(2000);
    server = await startTestServer(root);
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe('project settings', () => {
  it('defaults, is written deterministically, and is for people only', async () => {
    expect(await bot().getConfig()).toEqual({
      version: 1,
      policy: { default: 'review_destructive', agents: {} },
    });
    const config = {
      version: 1 as const,
      policy: {
        default: 'review_all' as const,
        agents: { z: 'auto' as const, a: 'locked' as const },
      },
    };
    expect((await failure(bot().setConfig(config))).code).toBe('forbidden');
    await ada().setConfig(config);
    const text = await readFile(projectPaths(root).config, 'utf8');
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"z"'));
    expect((await failure(ada().setConfig({ version: 2 } as never))).code).toBe('invalid_request');
  });

  it('follows edits of the file and keeps the last good settings when it breaks', async () => {
    const file = projectPaths(root).config;
    await writeFile(file, JSON.stringify({ version: 1, policy: { default: 'auto', agents: {} } }));
    await waitFor(async () => (await bot().getConfig()).policy.default === 'auto', {
      what: 'the config to reload',
    });
    expect((await bot().apply('plan', { ops: [{ op: 'remove_node', id: 'h2' }] })).status).toBe(
      'applied',
    );
    await writeFile(file, '{ broken');
    await sleep(1300);
    expect((await bot().getConfig()).policy.default).toBe('auto');
  });
});

// ── Follow-ups: undo under policy, batch ids, questions listed, actors ──────

describe('undo under the review policy', () => {
  it('refuses a locked agent', async () => {
    await bot().apply('plan', { ops: [{ op: 'add_node', node: { type: 'note', title: 'B' } }] });
    await ada().setConfig({ version: 1, policy: { default: 'locked', agents: {} } });
    const error = await failure(bot().undo('plan', { actorId: 'bot', scope: 'last' }));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('locked');
  });

  it('leaves what is no longer free for the agent, and reports why', async () => {
    const result = await bot().apply('plan', {
      ops: [
        { op: 'add_node', ref: 'a', node: { type: 'note', title: 'A' } },
        { op: 'add_node', ref: 'b', node: { type: 'note', title: 'B' } },
      ],
    });
    const a = result.refs.a as string;
    const b = result.refs.b as string;
    // A person moves A into a review frame; B stays where it was.
    await ada().apply('plan', {
      ops: [
        { op: 'update_node', id: 'f', patch: { props: { [FRAME_POLICY_PROP]: 'review' } } },
        { op: 'update_node', id: a, patch: { parent: 'f' } },
      ],
    });
    const undo = await bot().undo('plan', { batchId: result.batchId as string });
    expect(undo.undone).toEqual([result.batchId]);
    expect(undo.conflicts).toEqual([expect.objectContaining({ kind: 'node', id: a })]);
    const board = await ada().getBoard('plan');
    expect(board.nodes[a]).toBeDefined();
    expect(board.nodes[b]).toBeUndefined();
  });

  it('marks an item that only policy holds back as needing review', async () => {
    await ada().setConfig({ version: 1, policy: { default: 'auto', agents: {} } });
    const result = await bot().apply('plan', {
      ops: [{ op: 'add_node', ref: 'a', node: { type: 'note', title: 'A' } }],
    });
    await ada().setConfig({ version: 1, policy: { default: 'review_all', agents: {} } });
    const undo = await bot().undo('plan', { actorId: 'bot', scope: 'last' });
    expect(undo.undone).toEqual([]);
    expect(undo.conflicts).toEqual([
      {
        kind: 'node',
        id: result.refs.a,
        reason: 'needs review: every change by this agent waits for review',
      },
    ]);
    // A person is never restricted.
    expect((await ada().undo('plan', { batchId: result.batchId as string })).undone).toEqual([
      result.batchId,
    ]);
  });

  it('leaves the reviewed items of an accepted proposal to people', async () => {
    const proposed = await propose();
    await ada().decideProposal('plan', proposed.proposalId as string, { action: 'accept' });
    const [batch] = (await ada().history('plan', { actor: 'bot' })).batches;
    const undo = await bot().undo('plan', { batchId: batch?.id as string });
    const reasons = new Map(undo.conflicts.map((c) => [c.id, c.reason]));
    const reviewed = 'was applied through a reviewed proposal; ask a person to undo it';
    expect(reasons.get('h1')).toBe(reviewed);
    expect(reasons.get('h2')).toBe(reviewed);
    const board = await ada().getBoard('plan');
    // The free items (the new question and its edge) were undone.
    expect(board.nodes[proposed.refs.q as string]).toBeUndefined();
    expect(board.nodes.h1?.status).toBe('done');
    expect(board.nodes.h2).toBeUndefined();
  });

  it('skips comment-only batches for last and all, but undoes them by id', async () => {
    await ada().setConfig({ version: 1, policy: { default: 'auto', agents: {} } });
    const applied = await bot().apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'Edit' } }],
    });
    const c = await bot().comment('plan', { body: 'A note' });
    await bot().resolveThread('plan', c.id);
    const last = await bot().undo('plan', { actorId: 'bot', scope: 'last' });
    expect(last.undone).toEqual([applied.batchId]);
    expect(last.text).toContain(`${applied.batchId}: Added 1 node`);
    const resolve = (await ada().history('plan', { actor: 'bot' })).batches.find(
      (batch) => batch.source === 'ops' && batch.commentIds !== undefined,
    );
    expect(resolve?.commentIds).toEqual([c.id]);
    const byId = await bot().undo('plan', { batchId: resolve?.id as string });
    expect(byId.undone).toEqual([resolve?.id]);
  });
});

describe('batch ids, listed questions and the actor registry', () => {
  it('returns the batch an apply became', async () => {
    const result = await bot().apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'N' } }],
    });
    const [batch] = (await ada().history('plan')).batches;
    expect(result.batchId).toBe(batch?.id);
    const proposed = await propose();
    expect(proposed.batchId).toBeUndefined();
  });

  it('lists open questions, or all of them', async () => {
    const first = await bot().ask('plan', { question: 'One?' });
    await sleep(5); // oldest first is by creation time
    const second = await other().ask('plan', { question: 'Two?' });
    await ada().answerAsk('plan', first.id, { text: 'Yes' });
    const open = await ada().asks('plan');
    expect(open.asks.map((a) => a.id)).toEqual([second.id]);
    expect(open.text).toContain('1 open question');
    const all = await ada().asks('plan', { status: 'all' });
    expect(all.asks.map((a) => a.id)).toEqual([first.id, second.id]);
    expect(all.text).toContain('answered by Ada (human)');
    expect((await failure(ada().asks('plan', { status: 'nope' as never }))).code).toBe(
      'invalid_request',
    );
  });

  it('registers everyone who answers, decides, comments or undoes', async () => {
    const people = ['bea', 'cy', 'dan', 'eve'].map(
      (id): Actor => ({ id, kind: 'human', name: id.toUpperCase() }),
    );
    const [bea, cy, dan, eve] = people.map((actor) => server.api(actor)) as BoardApi[];
    const ask = await bot().ask('plan', { question: 'Q?' });
    await bea?.answerAsk('plan', ask.id, { text: 'A' });
    const proposed = await propose();
    await cy?.decideProposal('plan', proposed.proposalId as string, { action: 'reject' });
    await dan?.comment('plan', { body: 'Hi' });
    const applied = await bot().apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'N' } }],
    });
    await eve?.undo('plan', { batchId: applied.batchId as string });
    const board = await ada().getBoard('plan');
    for (const actor of [...people, BOT]) expect(board.actors[actor.id]).toEqual(actor);
  });

  it('does not deliver an answer again once the long-poll returned it', async () => {
    const ask = await bot().ask('plan', { question: 'Q?' });
    await ada().answerAsk('plan', ask.id, { text: 'A' });
    expect((await bot().askResult('plan', ask.id)).status).toBe('answered');
    expect((await bot().inbox('plan')).items).toEqual([]);
    await restart();
    expect((await bot().inbox('plan')).items).toEqual([]);
    expect((await bot().inbox('plan', { since: 0 })).items.map((i) => i.kind)).toEqual(['answer']);
  });
});

describe('proposal previews and authors', () => {
  it('registers the author of a proposal and of a question', async () => {
    await propose(other());
    await server.api({ id: 'asker', kind: 'agent', name: 'Asker' }).ask('plan', { question: 'Q?' });
    const board = await ada().getBoard('plan');
    expect(board.actors.other).toEqual(OTHER);
    expect(board.actors.asker?.name).toBe('Asker');
  });

  it('shows how existing frames would grow to hold the ghosts', async () => {
    const frame = (await ada().getBoard('plan')).nodes.f;
    const result = await bot().apply('plan', {
      ops: [
        ...['One', 'Two', 'Three', 'Four', 'Five'].map((title) => ({
          op: 'add_node' as const,
          node: { type: 'task' as const, title, parent: 'f' },
        })),
        { op: 'update_node', id: 'h1', patch: { status: 'done' } },
      ],
    });
    expect(result.status).toBe('proposed');
    const [proposal] = (await ada().proposals('plan')).proposals;
    const grown = proposal?.preview.views?.f;
    expect(grown).toBeDefined();
    expect((grown?.w ?? 0) * (grown?.h ?? 0)).toBeGreaterThan(
      (frame?.view?.w ?? 0) * (frame?.view?.h ?? 0),
    );
    expect(grown?.x).toBe(frame?.view?.x);
    for (const ghost of Object.values(proposal?.preview.nodes ?? {})) {
      expect(ghost.view).toBeDefined();
      expect((ghost.view?.x ?? 0) + (ghost.view?.w ?? 0)).toBeLessThanOrEqual(grown?.w ?? 0);
    }
  });
});
