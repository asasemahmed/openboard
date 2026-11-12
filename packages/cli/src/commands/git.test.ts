/**
 * Boards in git, against real temporary repositories. Git never sees the
 * user's configuration: `GIT_CONFIG_GLOBAL` points at a file inside the test's
 * directory and `GIT_CONFIG_NOSYSTEM` turns the system file off.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Actor,
  applyOps,
  type Board,
  type Op,
  parseBoard,
  serializeBoard,
} from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors.js';
import { captureIo, sampleBoard, tempDir } from '../testing/helpers.js';
import { diffCommand } from './diff.js';
import { runChecks } from './doctor.js';
import {
  DIFF_ATTRIBUTE,
  gitRemoveCommand,
  gitSetupCommand,
  gitStatus,
  gitStatusCommand,
  MERGE_ATTRIBUTE,
  mergeDriverCommand,
  textconvCommand,
} from './git.js';
import { initCommand } from './init.js';

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const hasGit = spawnSync('git', ['--version']).status === 0;

interface Repo {
  dir: string;
  env: Record<string, string>;
  git(...args: string[]): string;
  board(): Promise<Board>;
  edit(ops: Op[]): Promise<void>;
  commit(message: string): void;
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
    execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(dir, '.gitignore'), '.test-gitconfig\n');
  await initCommand(captureIo(dir));
  const file = path.join(dir, '.openboard/main.board.json');
  await writeFile(file, serializeBoard(sampleBoard()));
  const r: Repo = {
    dir,
    env,
    git,
    board: async () => parseBoard(await readFile(file, 'utf8')),
    edit: async (ops) => {
      const outcome = applyOps(await r.board(), ops, { actor: ADA });
      if (!outcome.ok) throw new Error(outcome.errors.map((e) => e.message).join('; '));
      await writeFile(file, serializeBoard(outcome.board));
    },
    commit: (message) => {
      git('add', '-A');
      git('commit', '-q', '-m', message);
    },
  };
  r.commit('Start');
  return r;
}

const io = (r: Repo) => captureIo(r.dir, r.env);

async function exitOf(promise: Promise<number>): Promise<number> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof CliError) return error.exitCode;
    throw error;
  }
}

describe.skipIf(!hasGit)('openboard diff', () => {
  it('compares the working tree with HEAD in each format, with diff-like exit codes', async () => {
    const r = await repo();
    const same = io(r);
    expect(await diffCommand(same, 'main', { root: r.dir })).toBe(0);
    expect(same.out()).toBe('Board main: no changes (HEAD → working tree).\n');

    await r.edit([
      { op: 'update_node', id: 'n_api', patch: { status: 'done', title: 'Build the API v2' } },
      { op: 'remove_node', id: 'n_risk' },
      { op: 'add_node', id: 'n_new', node: { type: 'note', title: 'Ship notes' } },
    ]);
    const text = io(r);
    expect(await diffCommand(text, undefined, { root: r.dir })).toBe(1);
    const out = text.out();
    expect(out).toMatch(/^Board main \(HEAD → working tree\): \d+ changes/);
    expect(out).toContain('  + note n_new "Ship notes"');
    expect(out).toContain('  - risk n_risk "Scope creep"');
    expect(out).toContain(
      '  ~ task n_api "Build the API v2": status: "in_progress" → "done"; title: "Build the API" → "Build the API v2"',
    );
    expect(out).toContain('  - edge "Scope creep" relates_to "Plan"');

    const md = io(r);
    expect(await diffCommand(md, 'main', { root: r.dir, format: 'markdown' })).toBe(1);
    expect(md.out()).toContain('### Board `main`: HEAD → working tree');
    expect(md.out()).toContain('**Added**');
    expect(md.out()).toContain('- note n\\_new "Ship notes"');

    const json = io(r);
    await diffCommand(json, 'main', { root: r.dir, format: 'json' });
    const diff = JSON.parse(json.out());
    expect(diff.nodes.added.map((n: { id: string }) => n.id)).toEqual(['n_new']);
    expect(diff.isEmpty).toBe(false);

    const svgFile = path.join(r.dir, 'diff.svg');
    const svg = io(r);
    await diffCommand(svg, 'main', { root: r.dir, format: 'svg', out: svgFile, theme: 'dark' });
    const picture = await readFile(svgFile, 'utf8');
    expect(picture).toMatch(/^(<\?xml[^>]*>\s*)?<svg\b/);
    expect(picture.trimEnd()).toMatch(/<\/svg>$/);
    expect(picture).toContain('Ship notes');

    r.commit('Edit');
    const between = io(r);
    expect(await diffCommand(between, 'main', { root: r.dir, from: 'HEAD~1', to: 'HEAD' })).toBe(1);
    expect(between.out()).toContain('HEAD~1 → HEAD');
    expect(await diffCommand(io(r), 'main', { root: r.dir })).toBe(0);
  });

  it('treats a board missing on one side as empty, and fails clearly with exit 2', async () => {
    const r = await repo();
    await writeFile(
      path.join(r.dir, '.openboard/second.board.json'),
      serializeBoard({ ...sampleBoard(), id: 'second', name: 'Second' }),
    );
    const added = io(r);
    expect(await diffCommand(added, 'second', { root: r.dir })).toBe(1);
    expect(added.out()).toContain('HEAD, where it does not exist → working tree');

    expect(await exitOf(diffCommand(io(r), 'main', { root: r.dir, from: '--output=x' }))).toBe(2);
    expect(await exitOf(diffCommand(io(r), 'main', { root: r.dir, from: 'nope' }))).toBe(2);
    expect(
      await exitOf(diffCommand(io(r), 'main', { root: r.dir, format: 'svg', to: 'HEAD' })),
    ).toBe(0);
    expect(await exitOf(diffCommand(io(r), undefined, { root: r.dir, format: 'svg' }))).toBe(2);
    await writeFile(path.join(r.dir, '.openboard/main.board.json'), '{ broken');
    await expect(diffCommand(io(r), 'main', { root: r.dir })).rejects.toThrow(
      /main\.board\.json in the working tree does not parse/,
    );
    const plain = await tempDir();
    await initCommand(captureIo(plain));
    await expect(diffCommand(captureIo(plain, r.env), 'main', { root: plain })).rejects.toThrow(
      'is not in a git repository',
    );
  });
});

describe.skipIf(!hasGit)('openboard git setup, status and remove', () => {
  it('is idempotent, leaves other .gitattributes lines alone, and undoes exactly what it added', async () => {
    const r = await repo();
    const attributes = path.join(r.dir, '.gitattributes');
    await writeFile(attributes, '*.png binary\n# keep me\n*.board.json linguist-generated');
    const setup = io(r);
    await gitSetupCommand(setup, { root: r.dir, diff: true });
    expect(setup.out()).toContain(`  ${MERGE_ATTRIBUTE}\n  ${DIFF_ATTRIBUTE}`);
    await gitSetupCommand(io(r), { root: r.dir, diff: true });
    expect(await readFile(attributes, 'utf8')).toBe(
      `*.png binary\n# keep me\n*.board.json linguist-generated\n${MERGE_ATTRIBUTE}\n${DIFF_ATTRIBUTE}\n`,
    );
    expect(r.git('config', '--local', 'merge.openboard.driver')).toContain(
      'merge-driver %O %A %B %P',
    );
    expect(r.git('config', '--local', 'diff.openboard.textconv')).toContain('textconv');
    expect(await gitStatus(io(r), { root: r.dir })).toMatchObject({
      attributes: { merge: true, diff: true },
      current: { merge: true, diff: true },
    });
    const status = io(r);
    await gitStatusCommand(status, { root: r.dir });
    expect(status.out()).toContain('Merge driver:   set up');
    expect(status.out()).toContain('Readable diffs: set up');

    await gitRemoveCommand(io(r), { root: r.dir });
    expect(await readFile(attributes, 'utf8')).toBe(
      '*.png binary\n# keep me\n*.board.json linguist-generated\n',
    );
    expect(
      spawnSync('git', ['config', '--local', 'merge.openboard.driver'], {
        cwd: r.dir,
        env: { ...process.env, ...r.env },
      }).status,
    ).toBe(1);
    const again = io(r);
    await gitRemoveCommand(again, { root: r.dir });
    expect(again.out()).toContain('Nothing to remove');
  });

  it('creates .gitattributes when needed, removes it when it is left empty, and writes --global to the global file only', async () => {
    const r = await repo();
    const attributes = path.join(r.dir, '.gitattributes');
    await gitSetupCommand(io(r), { root: r.dir, global: true });
    expect(await readFile(attributes, 'utf8')).toBe(`${MERGE_ATTRIBUTE}\n`);
    expect(await readFile(r.env.GIT_CONFIG_GLOBAL as string, 'utf8')).toContain(
      '[merge "openboard"]',
    );
    expect(
      spawnSync('git', ['config', '--local', 'merge.openboard.driver'], {
        cwd: r.dir,
        env: { ...process.env, ...r.env },
      }).status,
    ).toBe(1);
    await gitRemoveCommand(io(r), { root: r.dir, global: true });
    expect(existsSync(attributes)).toBe(false);
    expect(await readFile(r.env.GIT_CONFIG_GLOBAL as string, 'utf8')).not.toContain('driver');
  });

  it('doctor mentions the merge driver without failing', async () => {
    const r = await repo();
    const app = { dir: r.dir, built: true };
    const before = await runChecks(io(r), { root: r.dir, app });
    expect(before.find((c) => c.label.includes('merge'))).toMatchObject({ status: 'warn' });
    await gitSetupCommand(io(r), { root: r.dir });
    const after = await runChecks(io(r), { root: r.dir, app });
    expect(after.find((c) => c.label.includes('merge'))).toMatchObject({ status: 'ok' });
  });
});

describe.skipIf(!hasGit)('merge-driver and textconv', () => {
  it('merges three files, writes the result to ours, and reports what it decided', async () => {
    const dir = await tempDir();
    const base = sampleBoard();
    const edit = (ops: Op[]) => {
      const outcome = applyOps(base, ops, { actor: ADA });
      if (!outcome.ok) throw new Error('bad edit');
      return outcome.board;
    };
    const files = {
      base: path.join(dir, 'base'),
      ours: path.join(dir, 'ours'),
      theirs: path.join(dir, 'theirs'),
    };
    await writeFile(files.base, serializeBoard(base));
    await writeFile(
      files.ours,
      serializeBoard(edit([{ op: 'update_node', id: 'n_api', patch: { title: 'Ours' } }])),
    );
    await writeFile(
      files.theirs,
      serializeBoard(edit([{ op: 'update_node', id: 'n_api', patch: { title: 'Theirs' } }])),
    );
    const run = captureIo(dir);
    expect(
      await mergeDriverCommand(
        run,
        files.base,
        files.ours,
        files.theirs,
        '.openboard/main.board.json',
      ),
    ).toBe(0);
    expect(parseBoard(await readFile(files.ours, 'utf8')).nodes.n_api?.title).toBe('Ours');
    expect(run.err()).toMatch(/^openboard: \.openboard\/main\.board\.json: Merged with 1 conflict/);
    expect(await readFile(path.join(dir, '.openboard/.local/last-merge.txt'), 'utf8')).toContain(
      'n_api title',
    );
    expect(existsSync(path.join(dir, '.openboard/.local/.gitignore'))).toBe(true);

    // --strict: the same merge exits 1. --prefer theirs: their title wins.
    await writeFile(
      files.ours,
      serializeBoard(edit([{ op: 'update_node', id: 'n_api', patch: { title: 'Ours' } }])),
    );
    expect(
      await mergeDriverCommand(captureIo(dir), files.base, files.ours, files.theirs, undefined, {
        strict: true,
        prefer: 'theirs',
      }),
    ).toBe(1);
    expect(parseBoard(await readFile(files.ours, 'utf8')).nodes.n_api?.title).toBe('Theirs');

    // No common ancestor: an empty base.
    await writeFile(files.base, '');
    expect(await mergeDriverCommand(captureIo(dir), files.base, files.ours, files.theirs)).toBe(0);

    // A broken side: nothing is written.
    const kept = await readFile(files.ours, 'utf8');
    await writeFile(files.theirs, '<<<<<<< not a board');
    await expect(
      mergeDriverCommand(captureIo(dir), files.base, files.ours, files.theirs, 'b.board.json'),
    ).rejects.toThrow('cannot merge b.board.json: their version does not parse');
    expect(await readFile(files.ours, 'utf8')).toBe(kept);
  });

  it.skipIf(!existsSync(BIN))(
    'lets git merge two branches that edited the same board',
    async () => {
      const r = await repo();
      await gitSetupCommand(io(r), { root: r.dir });
      r.commit('Use the OpenBoard merge driver');
      const merge = (branch: string) =>
        spawnSync('git', ['merge', '--no-edit', branch], {
          cwd: r.dir,
          env: { ...process.env, ...r.env },
          encoding: 'utf8',
        });

      // Different nodes: clean.
      r.git('checkout', '-q', '-b', 'docs');
      await r.edit([{ op: 'update_node', id: 'n_docs', patch: { status: 'in_progress' } }]);
      r.commit('Start the docs');
      r.git('checkout', '-q', 'main');
      await r.edit([{ op: 'update_node', id: 'n_api', patch: { status: 'done' } }]);
      r.commit('Finish the API');
      const clean = merge('docs');
      expect(clean.status).toBe(0);
      let board = await r.board();
      expect([board.nodes.n_docs?.status, board.nodes.n_api?.status]).toEqual([
        'in_progress',
        'done',
      ]);
      expect(await readFile(path.join(r.dir, '.openboard/main.board.json'), 'utf8')).not.toContain(
        '<<<<<<<',
      );

      // The same field: resolved in favour of ours, reported, still a clean merge.
      r.git('checkout', '-q', '-b', 'rename');
      await r.edit([{ op: 'update_node', id: 'n_api', patch: { title: 'Public API' } }]);
      r.commit('Rename on a branch');
      r.git('checkout', '-q', 'main');
      await r.edit([{ op: 'update_node', id: 'n_api', patch: { title: 'Orders API' } }]);
      r.commit('Rename on main');
      const resolved = merge('rename');
      expect(resolved.status).toBe(0);
      expect(resolved.stderr).toContain('Merged with 1 conflict');
      expect((await r.board()).nodes.n_api?.title).toBe('Orders API');
      expect(
        await readFile(path.join(r.dir, '.openboard/.local/last-merge.txt'), 'utf8'),
      ).toContain('Public API');

      // Delete on one side, edit on the other: the edit is kept.
      r.git('checkout', '-q', '-b', 'cleanup');
      await r.edit([{ op: 'remove_node', id: 'n_risk' }]);
      r.commit('Remove the risk');
      r.git('checkout', '-q', 'main');
      await r.edit([{ op: 'update_node', id: 'n_risk', patch: { body: 'Still real.' } }]);
      r.commit('Explain the risk');
      expect(merge('cleanup').status).toBe(0);
      board = await r.board();
      expect(board.nodes.n_risk?.body).toBe('Still real.');
    },
  );

  it.skipIf(!existsSync(BIN))('makes git diff show readable board text', async () => {
    const r = await repo();
    await gitSetupCommand(io(r), { root: r.dir, diff: true });
    r.commit('Readable diffs');
    await r.edit([{ op: 'update_node', id: 'n_api', patch: { title: 'Build the public API' } }]);
    const diff = r.git('diff');
    expect(diff).toMatch(/^- +\[task\] n_api "Build the API" \(in_progress\)$/m);
    expect(diff).toMatch(/^\+ +\[task\] n_api "Build the public API" \(in_progress\)$/m);
    expect(diff).not.toContain('"updatedAt"');

    const out = captureIo(r.dir);
    await textconvCommand(out, '.openboard/main.board.json');
    expect(out.out()).toMatch(/^Board main "Launch", cursor 0:/);
    await writeFile(path.join(r.dir, 'broken.board.json'), 'not json');
    const raw = captureIo(r.dir);
    await textconvCommand(raw, 'broken.board.json');
    expect(raw.out()).toBe('not json');
  });
});
