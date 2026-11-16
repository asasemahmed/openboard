/**
 * Cards closed from commit messages: the message parser, the plan as a pure
 * function, and `openboard git sync` and its hooks against real temporary
 * repositories, with and without a running server. Git never sees the user's
 * configuration (see git.test.ts).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Board, parseBoard, serializeBoard } from '@openboard-dev/core';
import { describe, expect, it } from 'vitest';
import { startServer } from '../lib/server.js';
import { captureIo, sampleBoard, serverWorks, tempDir } from '../testing/helpers.js';
import { gitRemoveCommand, gitSetupCommand, gitStatus, HOOK_MARKER } from './git.js';
import {
  type Commit,
  commitLink,
  gitSyncCommand,
  hasCommit,
  parseClosedCards,
  planSync,
  rangeArgs,
} from './git-sync.js';
import { initCommand } from './init.js';

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const hasGit = spawnSync('git', ['--version']).status === 0;

describe('parseClosedCards', () => {
  it('reads each keyword in any case, anywhere in the message', () => {
    expect(parseClosedCards('Closes card n_api')).toEqual(['n_api']);
    expect(parseClosedCards('fixes card n_api')).toEqual(['n_api']);
    expect(parseClosedCards('RESOLVES CARD n_api')).toEqual(['n_api']);
    expect(parseClosedCards('Build the routes\n\nSome detail.\n\nResolves card n_api\n')).toEqual([
      'n_api',
    ]);
    expect(parseClosedCards('Retry payments (closes card n_pay)')).toEqual(['n_pay']);
    expect(parseClosedCards('Fixes\ncard n_api')).toEqual(['n_api']);
  });

  it('reads several ids, without repeats', () => {
    expect(parseClosedCards('Closes card a1, closes card b2')).toEqual(['a1', 'b2']);
    expect(parseClosedCards('Closes card a1, card b2 and card c3')).toEqual(['a1', 'b2', 'c3']);
    expect(parseClosedCards('Closes cards a1, b2, and c3')).toEqual(['a1', 'b2', 'c3']);
    expect(parseClosedCards('Fixes card a1. Resolves card a1 too')).toEqual(['a1']);
  });

  it('leaves punctuation, quotes and following words out', () => {
    expect(parseClosedCards('Closes card n_api.')).toEqual(['n_api']);
    expect(parseClosedCards('Closes card n_api: the routes')).toEqual(['n_api']);
    expect(parseClosedCards('Closes card `n_api`')).toEqual(['n_api']);
    expect(parseClosedCards("Closes card n_api's routes")).toEqual(['n_api']);
    expect(parseClosedCards('Closes card a1 and updates the docs')).toEqual(['a1']);
    expect(parseClosedCards('Closes card a1, then tidies up')).toEqual(['a1']);
    expect(parseClosedCards('Closes card a1. And card b2 is next')).toEqual(['a1']);
    expect(parseClosedCards('Closes card v1.2-rc')).toEqual(['v1.2-rc']);
  });

  it('ignores what only looks like a keyword or an id', () => {
    expect(parseClosedCards('Encloses card n_api')).toEqual([]);
    expect(parseClosedCards('Closes cardboard boxes')).toEqual([]);
    expect(parseClosedCards('Closed card n_api')).toEqual([]);
    expect(parseClosedCards('Closes n_api')).toEqual([]);
    expect(parseClosedCards('Closes card')).toEqual([]);
    expect(parseClosedCards('Closes card -rf')).toEqual([]);
    expect(parseClosedCards('Closes card #12')).toEqual([]);
    expect(parseClosedCards(`Closes card ${'a'.repeat(65)}`)).toEqual([]);
  });
});

describe('rangeArgs', () => {
  it('takes a range or one revision, and refuses anything else', () => {
    expect(rangeArgs('main..HEAD')).toEqual(['main..HEAD']);
    expect(rangeArgs('HEAD~3..')).toEqual(['HEAD~3..HEAD']);
    expect(rangeArgs('abc1234')).toEqual(['abc1234']);
    expect(() => rangeArgs('a...b')).toThrow('two dots');
    expect(() => rangeArgs('--all')).toThrow('not a revision');
    expect(() => rangeArgs('a..b..c')).toThrow('not a revision range');
  });
});

const commit = (sha: string, message: string): Commit => ({
  sha: sha.padEnd(40, '0'),
  short: sha.slice(0, 7),
  subject: message.split('\n')[0] ?? '',
  message,
});

describe('planSync', () => {
  it('closes cards, records the commit, and plans nothing the second time', () => {
    const board = sampleBoard();
    const commits = [
      commit('aaaaaaa1', 'Build the routes\n\nCloses card n_api'),
      commit('bbbbbbb2', 'Write the guide, fixes card n_docs and card n_api'),
    ];
    const plan = planSync([board], commits);
    expect(plan.warnings).toEqual([]);
    expect(plan.changes).toEqual([
      {
        board: 'main',
        node: 'n_api',
        title: 'Build the API',
        closed: true,
        commits: ['aaaaaaa', 'bbbbbbb'],
      },
      { board: 'main', node: 'n_docs', title: 'Write docs', closed: true, commits: ['bbbbbbb'] },
    ]);
    expect(plan.ops.get('main')).toEqual([
      {
        op: 'update_node',
        id: 'n_api',
        patch: {
          status: 'done',
          links: [
            { kind: 'commit', target: 'aaaaaaa Build the routes' },
            { kind: 'commit', target: 'bbbbbbb Write the guide, fixes card n_docs and card n_api' },
          ],
        },
      },
      {
        op: 'update_node',
        id: 'n_docs',
        patch: {
          status: 'done',
          links: [
            { kind: 'commit', target: 'bbbbbbb Write the guide, fixes card n_docs and card n_api' },
          ],
        },
      },
    ]);

    // As the board looks once the plan is applied: nothing left to do.
    const after: Board = structuredClone(board);
    for (const op of plan.ops.get('main') ?? []) {
      if (op.op !== 'update_node') continue;
      const node = after.nodes[op.id as string];
      if (node) Object.assign(node, op.patch);
    }
    const again = planSync([after], commits);
    expect(again.changes).toEqual([]);
    expect(again.ops.size).toBe(0);
  });

  it('records a commit on a card that is already done, without changing its status', () => {
    const board = sampleBoard();
    (board.nodes.n_api as { status?: string }).status = 'done';
    const plan = planSync([board], [commit('ccccccc3', 'Closes card n_api')]);
    expect(plan.changes[0]).toMatchObject({ node: 'n_api', closed: false });
    expect(plan.ops.get('main')?.[0]).toEqual({
      op: 'update_node',
      id: 'n_api',
      patch: { links: [{ kind: 'commit', target: 'ccccccc Closes card n_api' }] },
    });
  });

  it('warns about unknown ids and nodes without a status, and changes neither', () => {
    const plan = planSync(
      [sampleBoard()],
      [commit('ddddddd4', 'Closes card n_nope, card f_plan and card n_risk')],
    );
    expect(plan.ops.size).toBe(0);
    expect(plan.warnings).toEqual([
      'commit ddddddd closes card n_nope, which is on no board; ignored',
      'commit ddddddd closes f_plan on main, a frame without a status; ignored',
      'commit ddddddd closes n_risk on main, a risk without a status; ignored',
    ]);
  });

  it('skips reverts and a commit already recorded under another sha', () => {
    const board = sampleBoard();
    const api = board.nodes.n_api as { links?: unknown };
    api.links = [commitLink({ short: '1234567', subject: 'Build the routes, closes card n_api' })];
    const plan = planSync(
      [board],
      [
        commit('89abcde', 'Build the routes, closes card n_api'),
        commit('fedcba9', 'Revert "Build the routes, closes card n_api"'),
      ],
    );
    expect(plan.ops.size).toBe(0);
    expect(hasCommit(api.links as never, commit('1234567f', 'Something else'))).toBe(true);
    expect(hasCommit(api.links as never, commit('7654321', 'Something else'))).toBe(false);
  });
});

// ── Against real repositories ────────────────────────────────────────────────

interface Repo {
  dir: string;
  env: Record<string, string>;
  git(...args: string[]): string;
  board(): Promise<Board>;
  commit(message: string): Promise<void>;
}

async function repo(): Promise<Repo> {
  const dir = await tempDir();
  const env = {
    GIT_CONFIG_GLOBAL: path.join(dir, '.test-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(dir, '.gitignore'), '.test-gitconfig\n');
  await initCommand(captureIo(dir));
  const file = path.join(dir, '.openboard/main.board.json');
  await writeFile(file, serializeBoard(sampleBoard()));
  git('add', '-A');
  git('commit', '-q', '-m', 'Start');
  let n = 0;
  return {
    dir,
    env,
    git,
    board: async () => parseBoard(await readFile(file, 'utf8')),
    commit: async (message) => {
      n += 1;
      await writeFile(path.join(dir, `work-${n}.txt`), `${n}\n`);
      git('add', `work-${n}.txt`);
      git('commit', '-q', '-m', message);
    },
  };
}

const io = (r: Repo) => captureIo(r.dir, r.env);

describe.skipIf(!hasGit)('openboard git sync', () => {
  it('closes a card from the board file, once', async () => {
    const r = await repo();
    await r.commit('Build the routes\n\nCloses card n_api');
    const short = r.git('rev-parse', '--short', 'HEAD').trim();

    const first = io(r);
    expect(await gitSyncCommand(first, undefined, { root: r.dir })).toBe(0);
    expect(first.out()).toBe(`Closed card n_api "Build the API" on main (${short}).\n`);
    const board = await r.board();
    expect(board.nodes.n_api).toMatchObject({
      status: 'done',
      updatedBy: 'git',
      links: [{ kind: 'commit', target: `${short} Build the routes` }],
    });
    expect(board.actors.git).toEqual({ id: 'git', kind: 'system', name: 'git' });
    const text = await readFile(path.join(r.dir, '.openboard/main.board.json'), 'utf8');

    // Again, and by range: the card already records the commit, so nothing changes.
    for (const range of [undefined, 'HEAD~1..HEAD', 'HEAD']) {
      const again = io(r);
      expect(await gitSyncCommand(again, range, { root: r.dir })).toBe(0);
      expect(again.out()).toBe(
        'Nothing to change: every card these commits close already records them.\n',
      );
    }
    expect(await readFile(path.join(r.dir, '.openboard/main.board.json'), 'utf8')).toBe(text);

    // An amended commit is the same work: it is not recorded twice.
    r.git('commit', '-q', '--amend', '-m', 'Build the routes\n\nCloses card n_api');
    expect(await gitSyncCommand(io(r), undefined, { root: r.dir })).toBe(0);
    expect(await readFile(path.join(r.dir, '.openboard/main.board.json'), 'utf8')).toBe(text);

    const none = io(r);
    expect(await gitSyncCommand(none, 'HEAD~1', { root: r.dir })).toBe(0);
    expect(none.out()).toBe('No card to close in 1 commit.\n');
  });

  it('warns about unknown ids and honours --dry-run', async () => {
    const r = await repo();
    const empty = io(r);
    expect(await gitSyncCommand(empty, undefined, { root: r.dir })).toBe(0);
    expect(empty.out()).toBe('No card to close in 1 commit.\n');
    await r.commit('Tidy up, fixes card n_nope');
    await r.commit('Resolves cards n_docs and n_api');
    const before = await readFile(path.join(r.dir, '.openboard/main.board.json'), 'utf8');

    const dry = io(r);
    expect(await gitSyncCommand(dry, undefined, { root: r.dir, dryRun: true })).toBe(0);
    expect(dry.err()).toMatch(
      /^warning: commit [0-9a-f]+ closes card n_nope, which is on no board; ignored\n$/,
    );
    expect(dry.out()).toContain('Would close card n_docs "Write docs" on main');
    expect(dry.out()).toContain('Dry run: nothing was changed.');
    expect(await readFile(path.join(r.dir, '.openboard/main.board.json'), 'utf8')).toBe(before);

    const real = io(r);
    expect(await gitSyncCommand(real, undefined, { root: r.dir })).toBe(0);
    expect(real.out().split('\n').filter(Boolean)).toHaveLength(2);
    const board = await r.board();
    expect([board.nodes.n_api?.status, board.nodes.n_docs?.status]).toEqual(['done', 'done']);
    expect(Object.keys(board.nodes).sort()).toEqual(Object.keys(sampleBoard().nodes).sort());
  });

  it('fails plainly outside a repository, and never from a hook', async () => {
    const dir = await tempDir();
    await initCommand(captureIo(dir));
    await expect(gitSyncCommand(captureIo(dir), undefined, { root: dir })).rejects.toThrow(
      'is not in a git repository',
    );
    const hook = captureIo(dir);
    expect(await gitSyncCommand(hook, undefined, { root: dir, hook: 'post-commit' })).toBe(0);
    expect(hook.err()).toContain('openboard: git sync: ');
    await expect(
      gitSyncCommand(captureIo(dir), 'main..', { root: dir, hook: 'post-merge' }),
    ).resolves.toBe(0);
  });

  it('reads only what a hook brought in', async () => {
    const r = await repo();
    await r.commit('Closes card n_docs');
    await r.commit('Closes card n_api');
    const commit = io(r);
    expect(await gitSyncCommand(commit, undefined, { root: r.dir, hook: 'post-commit' })).toBe(0);
    expect(commit.out()).toMatch(
      /^openboard: Closed card n_api "Build the API" on main \([0-9a-f]+\)\.\n$/,
    );
    expect((await r.board()).nodes.n_docs?.status).toBe('todo');
    // Nothing to say is said by nobody.
    const quiet = io(r);
    expect(await gitSyncCommand(quiet, undefined, { root: r.dir, hook: 'post-commit' })).toBe(0);
    expect(quiet.out() + quiet.err()).toBe('');
  });

  it.skipIf(!serverWorks)('goes through the running server as the git actor', async () => {
    const r = await repo();
    const server = await startServer({ root: r.dir, port: 0 });
    try {
      await r.commit('Ship the docs. Closes card n_docs');
      const out = io(r);
      expect(await gitSyncCommand(out, undefined, { root: r.dir })).toBe(0);
      expect(out.out()).toContain('Closed card n_docs "Write docs" on main');

      const api = server.api({ id: 'ada', kind: 'human', name: 'Ada' });
      const board = await api.getBoard('main');
      expect(board.nodes.n_docs).toMatchObject({ status: 'done', updatedBy: 'git' });
      const history = await api.history('main');
      expect(history.batches[0]).toMatchObject({
        actor: 'git',
        reason: expect.stringMatching(/^Closed by commit [0-9a-f]+$/),
      });

      const again = io(r);
      expect(await gitSyncCommand(again, 'HEAD~1..', { root: r.dir })).toBe(0);
      expect(again.out()).toContain('Nothing to change');
      expect((await api.history('main')).batches).toHaveLength(history.batches.length);
    } finally {
      await server.close();
    }
  });
});

describe.skipIf(!hasGit)('openboard git setup --hooks', () => {
  const hookFile = (r: Repo, name: string) => path.join(r.dir, '.git/hooks', name);

  it('installs, reports and removes its own hooks', async () => {
    const r = await repo();
    const setup = io(r);
    expect(await gitSetupCommand(setup, { root: r.dir, hooks: true })).toBe(0);
    expect(setup.out()).toContain('Installed .git/hooks/post-commit and .git/hooks/post-merge');
    const script = await readFile(hookFile(r, 'post-commit'), 'utf8');
    expect(script).toContain(HOOK_MARKER);
    expect(script).toMatch(/ git sync --hook post-commit \|\| true\nexit 0\n$/);
    expect(statSync(hookFile(r, 'post-commit')).mode & 0o111).not.toBe(0);
    expect((await gitStatus(io(r), { root: r.dir })).hooks).toEqual({
      'post-commit': 'openboard',
      'post-merge': 'openboard',
    });
    // Again: ours are rewritten, nothing else happens.
    expect(await gitSetupCommand(io(r), { root: r.dir, hooks: true })).toBe(0);

    const remove = io(r);
    expect(await gitRemoveCommand(remove, { root: r.dir })).toBe(0);
    expect(remove.out()).toContain('Removed the hooks: post-commit, post-merge');
    expect(existsSync(hookFile(r, 'post-commit'))).toBe(false);
  });

  it('never replaces a hook of your own, and says how to chain to it', async () => {
    const r = await repo();
    await mkdir(path.join(r.dir, '.git/hooks'), { recursive: true });
    const mine = '#!/bin/sh\necho mine\n';
    await writeFile(hookFile(r, 'post-merge'), mine, { mode: 0o755 });
    const setup = io(r);
    expect(await gitSetupCommand(setup, { root: r.dir, hooks: true })).toBe(1);
    expect(setup.out()).toContain('Installed .git/hooks/post-commit:');
    expect(setup.err()).toContain(
      "openboard: .git/hooks/post-merge is not OpenBoard's, so it was left as it is. To chain to it, add this line to it:\n  ",
    );
    expect(setup.err()).toMatch(/ git sync --hook post-merge \|\| true\n$/);
    expect(await readFile(hookFile(r, 'post-merge'), 'utf8')).toBe(mine);

    // Chained by hand: recognised, and still never touched or removed.
    const line = setup.err().trim().split('\n').pop()?.trim() ?? '';
    await writeFile(hookFile(r, 'post-merge'), `${mine}${line}\n`);
    expect((await gitStatus(io(r), { root: r.dir })).hooks['post-merge']).toBe('chained');
    expect(await gitSetupCommand(io(r), { root: r.dir, hooks: true })).toBe(0);
    await gitRemoveCommand(io(r), { root: r.dir });
    expect(await readFile(hookFile(r, 'post-merge'), 'utf8')).toBe(`${mine}${line}\n`);
  });

  it('names a project in a subdirectory of the repository', async () => {
    const r = await repo();
    const sub = path.join(r.dir, 'app');
    await mkdir(sub);
    await initCommand(captureIo(sub));
    expect(await gitSetupCommand(io(r), { root: sub, hooks: true })).toBe(0);
    expect(await readFile(hookFile(r, 'post-commit'), 'utf8')).toContain(
      'git sync --hook post-commit --root app || true',
    );
  });

  it.skipIf(!existsSync(BIN))(
    'closes the card when git commits and merges',
    async () => {
      const r = await repo();
      expect(await gitSetupCommand(io(r), { root: r.dir, hooks: true })).toBe(0);
      await r.commit('Build the routes, closes card n_api');
      expect((await r.board()).nodes.n_api?.status).toBe('done');

      // A pulled commit, through post-merge. The card change is committed like any other.
      r.git('commit', '-q', '-a', '-m', 'Update the board');
      r.git('checkout', '-q', '-b', 'docs', 'HEAD~2');
      await r.commit('Write the guide (fixes card n_docs)');
      r.git('checkout', '-q', '--', '.openboard');
      r.git('checkout', '-q', 'main');
      r.git('merge', '-q', '--no-edit', 'docs');
      expect((await r.board()).nodes.n_docs?.status).toBe('done');

      // A commit with an unknown id still commits.
      const result = spawnSync(
        'git',
        ['commit', '-q', '--allow-empty', '-m', 'Closes card n_nope'],
        {
          cwd: r.dir,
          env: { ...process.env, ...r.env },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('closes card n_nope, which is on no board; ignored');
    },
    30_000,
  );
});
