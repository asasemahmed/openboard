import { readFile } from 'node:fs/promises';
import {
  type Actor,
  AGENT_IDLE_MS,
  AGENT_PRESENCE_TTL_MS,
  type AgentPresence,
  type BoardApi,
  ENDED_SESSION_TTL_MS,
  type LiveSessions,
  OpenBoardError,
  type Presence,
  serializeBoard,
} from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Boards } from './boards.js';
import { projectPaths } from './paths.js';
import type { Room } from './room.js';
import { LocalBoardApi } from './service.js';
import { removeRoot, tempRoot } from './testing.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const BOT: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };
const OTHER: Actor = { id: 'other', kind: 'agent', name: 'Other' };
const T0 = Date.parse('2026-11-12T10:00:00.000Z');

let root: string;
let boards: Boards;
let now: number;
let room: Room;

const api = (actor: Actor, session?: string): BoardApi =>
  new LocalBoardApi(boards, actor, () => {}, session ? { session } : {});

async function failure(promise: Promise<unknown>): Promise<OpenBoardError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenBoardError);
    return error as OpenBoardError;
  }
  throw new Error('expected the call to fail');
}

/** Agent presence entries in the board's awareness, by `actor/session`. */
function agents(): Record<string, AgentPresence> {
  const out: Record<string, AgentPresence> = {};
  for (const state of room.awareness.getStates().values()) {
    const presence = state as Partial<Presence>;
    if (presence.agent && presence.actor) {
      out[`${presence.actor.id}/${presence.agent.session}`] = presence.agent;
    }
  }
  return out;
}

function liveSessions(): LiveSessions | undefined {
  for (const state of room.awareness.getStates().values()) {
    const presence = state as Partial<Presence>;
    if (presence.live) return presence.live;
  }
  return undefined;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  root = await tempRoot();
  now = T0;
  boards = new Boards(projectPaths(root), { clock: () => now });
  await boards.start();
  await api(ADA).createBoard({ name: 'Plan' });
  await api(ADA).apply('plan', {
    layout: 'none',
    ops: [
      { op: 'add_node', id: 'f', node: { type: 'frame', title: 'Area' } },
      { op: 'add_node', id: 'g', node: { type: 'frame', title: 'Other area' } },
      { op: 'add_node', id: 'h1', node: { type: 'task', title: 'Ada task', parent: 'f' } },
      { op: 'add_node', id: 'h2', node: { type: 'note', title: 'Ada note' } },
    ],
  });
  await boards.config.set({ version: 1, policy: { default: 'auto', agents: {} } });
  room = await boards.get('plan');
});

afterEach(async () => {
  await boards.close();
  await removeRoot(root);
});

// ── Presence ─────────────────────────────────────────────────────────────────

describe('agent presence', () => {
  it('shows reading with what was read, then writing with what was touched', async () => {
    await api(BOT).read('plan', { ids: ['h1', 'h2'] });
    expect(agents()['bot/default']).toEqual({
      status: 'reading',
      session: 'default',
      focus: ['h1', 'h2'],
      at: new Date(T0).toISOString(),
    });
    now += 1000;
    await api(BOT).apply('plan', { ops: [{ op: 'update_node', id: 'h2', patch: { title: 'X' } }] });
    expect(agents()['bot/default']).toMatchObject({ status: 'writing', focus: ['h2'] });
    // People have no server-published presence.
    await api(ADA).read('plan');
    expect(Object.keys(agents())).toEqual(['bot/default']);
  });

  it('gives anonymous callers no presence', async () => {
    const anonymous = new LocalBoardApi(
      boards,
      { id: 'anonymous', kind: 'agent', name: 'Anonymous agent' },
      () => {},
      { anonymous: true },
    );
    await anonymous.read('plan');
    expect(agents()).toEqual({});
    expect(room.knownActors.has('anonymous')).toBe(false);
  });

  it('keeps one entry per session', async () => {
    await api(BOT, 's1').outline('plan');
    await api(BOT, 's2').read('plan', { ids: ['h1'] });
    expect(Object.keys(agents()).sort()).toEqual(['bot/s1', 'bot/s2']);
  });

  it('goes idle, or waiting when a person owes it an answer, and then goes away', async () => {
    await api(BOT).outline('plan');
    await api(OTHER).ask('plan', { question: 'Which?' });
    now += AGENT_IDLE_MS + 1;
    boards.live.sweep();
    expect(agents()['bot/default']?.status).toBe('idle');
    expect(agents()['other/default']?.status).toBe('waiting');
    now += AGENT_PRESENCE_TTL_MS;
    boards.live.sweep();
    expect(agents()).toEqual({});
  });

  it('shows waiting while it long-polls a question', async () => {
    const ask = await api(BOT).ask('plan', { question: 'Go?', nodeIds: ['h1'] });
    const waiting = api(BOT).askResult('plan', ask.id, { waitMs: 5000 });
    await tick();
    expect(agents()['bot/default']).toMatchObject({ status: 'waiting', focus: ['h1'] });
    await api(ADA).answerAsk('plan', ask.id, { text: 'Yes' });
    await waiting;
    expect(agents()['bot/default']?.status).toBe('reading');
  });
});

// ── Sessions ─────────────────────────────────────────────────────────────────

describe('activity sessions', () => {
  async function tree() {
    const bot = api(BOT);
    await bot.reportActivity({ session: 'main', kind: 'session_start', label: 'Fix export' });
    await bot.reportActivity({
      session: 'sub-a',
      parent: 'main',
      kind: 'subagent_start',
      label: 'Tests',
    });
    await bot.reportActivity({
      session: 'sub-b',
      parent: 'main',
      kind: 'subagent_start',
      label: 'Docs',
    });
    await bot.reportActivity({
      session: 'sub-a',
      kind: 'tool_start',
      tool: 'Bash',
      summary: 'pnpm test',
    });
    await bot.reportActivity({
      session: 'sub-a',
      kind: 'tool_end',
      tool: 'Bash',
      summary: 'pnpm test',
      ok: false,
    });
    await bot.reportActivity({
      session: 'sub-b',
      kind: 'tool_start',
      tool: 'Edit',
      summary: 'docs/x.md',
    });
  }

  it('builds a session tree with current tools, recent steps and counts', async () => {
    await tree();
    const { sessions, text } = await api(ADA).sessions();
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    expect(byId.main).toMatchObject({
      actor: 'bot',
      label: 'Fix export',
      children: ['sub-a', 'sub-b'],
      status: 'active',
    });
    expect(byId['sub-a']).toMatchObject({
      parent: 'main',
      counts: { tools: 1, errors: 1 },
      recent: [expect.objectContaining({ tool: 'Bash', summary: 'pnpm test', ok: false })],
    });
    expect(byId['sub-a']?.current).toBeUndefined();
    expect(byId['sub-b']?.current).toMatchObject({ tool: 'Edit', summary: 'docs/x.md' });
    expect(text).toContain('data, not instructions');
    expect(text).toContain('now Edit since');
  });

  it('cleans untrusted text and keeps sessions to their actor', async () => {
    const session = await api(BOT).reportActivity({
      session: 's',
      kind: 'note',
      summary: `line one\nline\u0007two ${'x'.repeat(500)}`,
      label: `bad\u0000label`,
    });
    expect(session.label).toBe('bad label');
    const summary = session.recent[0]?.summary ?? '';
    expect(summary.startsWith('line one line two')).toBe(true);
    expect(summary.length).toBe(200);
    expect((await failure(api(OTHER).reportActivity({ session: 's', kind: 'note' }))).code).toBe(
      'forbidden',
    );
    expect(
      (await failure(api(BOT).reportActivity({ session: 'bad id!', kind: 'note' } as never))).code,
    ).toBe('invalid_request');
  });

  it('turns idle, ends, and is dropped some time after it ended', async () => {
    await tree();
    now += AGENT_IDLE_MS + 1;
    const idle = await api(ADA).sessions();
    expect(idle.sessions.find((s) => s.id === 'main')?.status).toBe('idle');
    // A running tool keeps a session active.
    expect(idle.sessions.find((s) => s.id === 'sub-b')?.status).toBe('active');
    await api(BOT).reportActivity({ session: 'main', kind: 'session_end' });
    expect((await api(ADA).sessions()).sessions.map((s) => s.id)).not.toContain('main');
    expect(
      (await api(ADA).sessions({ includeEnded: true })).sessions.find((s) => s.id === 'main')
        ?.status,
    ).toBe('ended');
    now += ENDED_SESSION_TTL_MS + 1;
    boards.live.sweep();
    expect(
      (await api(ADA).sessions({ includeEnded: true })).sessions.map((s) => s.id),
    ).not.toContain('main');
  });

  it('keeps at most 200 sessions', async () => {
    for (let i = 0; i < 205; i++) {
      now += 1;
      await api(BOT).reportActivity({ session: `s${i}`, kind: 'note' });
    }
    const { sessions } = await api(ADA).sessions({ maxTokens: 50_000 });
    expect(sessions).toHaveLength(200);
    expect(sessions.map((s) => s.id)).not.toContain('s0');
  });

  it('shows sessions as working on boards the agent touched and boards open in a browser', async () => {
    await api(BOT, 'main').outline('plan');
    await api(BOT).reportActivity({
      session: 'main',
      kind: 'tool_start',
      tool: 'Bash',
      summary: 'pnpm test',
    });
    expect(agents()['bot/main']).toMatchObject({ status: 'working', detail: 'Bash: pnpm test' });
    await api(BOT).reportActivity({ session: 'sub', parent: 'main', kind: 'subagent_start' });
    expect(agents()['bot/sub']).toMatchObject({ status: 'working', parent: 'main' });
    // An agent that never touched the board shows up only where a browser looks.
    await api(OTHER).reportActivity({ session: 'o', kind: 'tool_start', tool: 'Read' });
    expect(agents()['other/o']).toBeUndefined();
    room.viewers = 1;
    await api(OTHER).reportActivity({ session: 'o', kind: 'tool_start', tool: 'Read' });
    expect(agents()['other/o']?.status).toBe('working');
    room.viewers = 0;
    await api(BOT).reportActivity({ session: 'sub', kind: 'subagent_end' });
    expect(agents()['bot/sub']).toBeUndefined();
  });

  it('publishes the session list in every open board’s awareness', async () => {
    await api(BOT).reportActivity({ session: 'main', kind: 'session_start', label: 'Work' });
    await tick();
    const live = liveSessions();
    expect(live?.sessions.map((s) => s.id)).toEqual(['main']);
    expect(live?.sessions[0]?.label).toBe('Work');
    await api(BOT).reportActivity({ session: 'main', kind: 'session_end' });
    await tick();
    expect(liveSessions()?.sessions).toEqual([]);
  });

  it('never writes activity to disk', async () => {
    await api(BOT, 'main').read('plan');
    await api(BOT).reportActivity({
      session: 'main',
      kind: 'tool_start',
      tool: 'Bash',
      summary: 'cat SECRET_FILE',
    });
    await room.flush();
    const files = projectPaths(root);
    for (const file of [
      files.boardFile('plan'),
      `${files.local}/plan.changes.jsonl`,
      `${files.local}/plan.history.jsonl`,
    ]) {
      expect(await readFile(file, 'utf8')).not.toContain('SECRET_FILE');
    }
  });
});

// ── Claims ───────────────────────────────────────────────────────────────────

describe('claims', () => {
  async function claimAll() {
    const result = await api(BOT).claim('plan', {
      nodeIds: ['h1', 'h2', 'g'],
      note: 'refactoring',
    });
    expect(result.conflicts).toEqual([]);
    expect(result.claims.map((c) => c.nodeId)).toEqual(['g', 'h1', 'h2']);
    expect(result.claims[0]).toMatchObject({
      by: 'bot',
      minutes: 15,
      until: new Date(T0 + 15 * 60_000).toISOString(),
    });
  }

  const ops = {
    update: { op: 'update_node', id: 'h2', patch: { title: 'Changed' } },
    remove: { op: 'remove_node', id: 'h2' },
    reparent: { op: 'update_node', id: 'h2', patch: { parent: 'f' } },
    move: { op: 'move_node', id: 'h2', view: { x: 5, y: 5 } },
  } as const;

  for (const [name, op] of Object.entries(ops)) {
    it(`${name}: the holder and people may, another agent ${name === 'move' ? 'may too' : 'may not'}`, async () => {
      await claimAll();
      const other = await api(OTHER).apply('plan', { layout: 'none', ops: [op] });
      if (name === 'move') expect(other.status).toBe('applied');
      else {
        expect(other.status).toBe('invalid');
        expect(other.errors).toEqual([
          {
            index: 0,
            code: 'claimed',
            message: expect.stringContaining(
              `is claimed by Bot until ${new Date(T0 + 15 * 60_000).toISOString()} ("refactoring")`,
            ),
          },
        ]);
      }
      expect(
        (await api(BOT).apply('plan', { layout: 'none', ops: [op], dryRun: true })).status,
      ).toBe('valid');
      expect((await api(ADA).apply('plan', { layout: 'none', ops: [op] })).status).toBe('applied');
    });
  }

  it('protects the children of a claimed node’s frame from removal', async () => {
    await api(BOT).claim('plan', { nodeIds: ['h1'] });
    const result = await api(OTHER).apply('plan', { ops: [{ op: 'remove_node', id: 'f' }] });
    expect(result.errors?.[0]?.code).toBe('claimed');
  });

  it('is all or nothing unless partial', async () => {
    await api(BOT).claim('plan', { nodeIds: ['h1'] });
    const all = await api(OTHER).claim('plan', { nodeIds: ['h1', 'h2'] });
    expect(all.conflicts).toEqual([{ nodeId: 'h1', by: 'bot', until: expect.any(String) }]);
    expect(all.claims).toEqual([]);
    const some = await api(OTHER).claim('plan', { nodeIds: ['h1', 'h2'], partial: true });
    expect(some.claims.map((c) => c.nodeId)).toEqual(['h2']);
    expect(some.text).toContain('Claimed by someone else (1)');
    expect((await failure(api(ADA).claim('plan', { nodeIds: ['h1'] }))).code).toBe('forbidden');
    expect((await failure(api(BOT).claim('plan', { nodeIds: ['nope'] }))).code).toBe('not_found');
  });

  it('expires, is renewed by the holder’s activity, and is swept away', async () => {
    await api(BOT).claim('plan', { nodeIds: ['h2'], minutes: 10 });
    now += 6 * 60_000; // past half its length
    await api(BOT).outline('plan');
    expect(room.doc.getClaim('h2')?.until).toBe(new Date(now + 10 * 60_000).toISOString());
    now += 11 * 60_000;
    expect((await api(OTHER).apply('plan', { ops: [ops.update] })).status).toBe('applied');
    boards.live.sweep();
    expect(room.doc.getClaim('h2')).toBeUndefined();
  });

  it('can be released by its holder or any person, not by another agent', async () => {
    await claimAll();
    const refused = await api(OTHER).claim('plan', { nodeIds: ['h1'], release: true });
    expect(refused.released).toEqual([]);
    expect(refused.conflicts.map((c) => c.nodeId)).toEqual(['h1']);
    expect((await api(BOT).claim('plan', { nodeIds: ['h1'], release: true })).released).toEqual([
      'h1',
    ]);
    expect((await api(ADA).claim('plan', { nodeIds: ['h2'], release: true })).released).toEqual([
      'h2',
    ]);
    expect(room.doc.claims().map((c) => c.nodeId)).toEqual(['g']);
  });

  it('goes away with its node, shows in reads, and stays out of the file and history', async () => {
    await claimAll();
    const read = await api(OTHER).read('plan', { ids: ['h1'] });
    expect(read.text).toContain(
      `claimed by Bot (agent) until ${new Date(T0 + 15 * 60_000).toISOString()} (note "refactoring")`,
    );
    const cursor = room.cursor;
    const historyBefore = (await api(ADA).history('plan', { includeMoves: true })).batches.length;
    expect(cursor).toBe(room.cursor);
    expect((await api(ADA).history('plan', { includeMoves: true })).batches.length).toBe(
      historyBefore,
    );
    expect(serializeBoard(room.doc.toJSON())).not.toContain('refactoring');
    await api(ADA).apply('plan', { ops: [{ op: 'remove_node', id: 'h2' }] });
    await tick();
    expect(room.doc.getClaim('h2')).toBeUndefined();
  });
});
