import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { type Actor, type BoardApi, OpenBoardError } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPaths } from './paths.js';
import { api, removeRoot, startTestServer, tempRoot, waitFor } from './testing.js';
import type { OpenBoardServer } from './types.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const BOT: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };

/** Git with a fixed identity and no user or system configuration. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.com',
};

let root: string;
let server: OpenBoardServer;
let ada: BoardApi;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' });
}

async function failure(promise: Promise<unknown>): Promise<OpenBoardError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenBoardError);
    return error as OpenBoardError;
  }
  throw new Error('expected the call to fail');
}

/** Wait until the board file on disk holds `text`. */
async function saved(text: string): Promise<void> {
  const file = projectPaths(root).boardFile('plan');
  await waitFor(async () => (await readFile(file, 'utf8')).includes(text), { what: 'the save' });
}

async function commit(subject: string): Promise<void> {
  git('add', '.openboard/plan.board.json');
  git('commit', '-q', '-m', subject);
}

beforeEach(async () => {
  root = await tempRoot();
  server = await startTestServer(root);
  ada = server.api(ADA);
  await ada.createBoard({ name: 'Plan' });
  await ada.apply('plan', {
    ops: [
      { op: 'add_node', id: 'api', node: { type: 'task', title: 'Build the API', status: 'todo' } },
      { op: 'add_node', id: 'docs', node: { type: 'task', title: 'Write docs' } },
      { op: 'add_edge', id: 'e1', edge: { type: 'depends_on', source: 'docs', target: 'api' } },
    ],
  });
  await saved('Write docs');
});

afterEach(async () => {
  await server.close();
  await removeRoot(root);
});

describe('outside git', () => {
  it('reports an untracked board without failing', async () => {
    const result = await ada.revisions('plan');
    expect(result).toMatchObject({ tracked: false, revisions: [], dirty: false });
    expect(result.text).toContain('not tracked by git');
    expect((await failure(ada.boardAtRevision('plan', 'HEAD'))).code).toBe('not_found');
  });

  it('reports a board that is in a repository but never committed as untracked', async () => {
    git('init', '-q');
    expect((await ada.revisions('plan')).tracked).toBe(false);
  });
});

describe('in a git repository', () => {
  beforeEach(async () => {
    git('init', '-q');
    await commit('Plan the API');
    await ada.apply('plan', {
      ops: [
        { op: 'update_node', id: 'api', patch: { status: 'done', title: 'Ship the API' } },
        { op: 'remove_node', id: 'docs' },
        { op: 'add_node', id: 'risk', node: { type: 'risk', title: 'No rate limit' } },
      ],
    });
    await saved('No rate limit');
    await commit('Ship it');
  });

  it('lists the revisions of the board file and whether it has uncommitted changes', async () => {
    const result = await ada.revisions('plan');
    expect(result.tracked).toBe(true);
    expect(result.dirty).toBe(false);
    expect(result.revisions.map((r) => r.subject)).toEqual(['Ship it', 'Plan the API']);
    expect(result.revisions[0]).toMatchObject({
      author: 'Test Author',
      rev: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(result.text).toContain('"Ship it"');
    expect((await ada.revisions('plan', { limit: 1 })).revisions).toHaveLength(1);

    await ada.apply('plan', { ops: [{ op: 'update_node', id: 'api', patch: { title: 'Later' } }] });
    await saved('Later');
    expect((await ada.revisions('plan')).dirty).toBe(true);
  });

  it('reads the board as committed in a revision', async () => {
    const old = await ada.boardAtRevision('plan', 'HEAD~1');
    expect(Object.keys(old.nodes).sort()).toEqual(['api', 'docs']);
    const head = await ada.boardAtRevision('plan', 'HEAD');
    expect(head.nodes.api?.title).toBe('Ship the API');
    const [first] = (await ada.revisions('plan')).revisions.slice(-1);
    expect((await ada.boardAtRevision('plan', first?.short as string)).nodes.docs).toBeDefined();
  });

  it('diffs two revisions, or a revision and the live board', async () => {
    const result = await ada.diffRevisions('plan', { from: 'HEAD~1', to: 'HEAD' });
    expect(result.diff.nodes.added.map((n) => n.id)).toEqual(['risk']);
    expect(result.diff.nodes.removed.map((n) => n.id)).toEqual(['docs']);
    expect(result.text).toContain('changes from HEAD~1 to HEAD');
    expect(result.text).toContain('+ [risk] risk "No rate limit"');
    expect(result.text).toContain('- [task] docs "Write docs"');
    expect(result.text).toContain(
      '~ [task] api "Build the API": status "todo" → "done", title "Build the API" → "Ship the API"',
    );
    expect(result.text).toContain('- edge e1 "Write docs" -depends_on-> "Build the API"');

    await ada.apply('plan', {
      ops: [{ op: 'update_node', id: 'risk', patch: { status: 'todo' } }],
    });
    const live = await ada.diffRevisions('plan', { from: 'HEAD' });
    expect(live.to).toBe('live');
    expect(live.text).toContain('~ [risk] risk "No rate limit": status (none) → "todo"');
    const none = await ada.diffRevisions('plan', { from: 'HEAD', to: 'HEAD' });
    expect(none.text).toBe('Board plan: no changes from HEAD to HEAD.');
  });

  it('refuses hostile and unknown revisions', async () => {
    for (const rev of [
      '--output=/tmp/pwned',
      '-p',
      'HEAD:../../etc/passwd',
      'HEAD..HEAD~1',
      'HEAD;rm -rf /',
      '$(id)',
      'HEAD@{-1}',
      '',
    ]) {
      expect((await failure(ada.boardAtRevision('plan', rev))).code, rev).toBe('invalid_request');
    }
    expect((await failure(ada.boardAtRevision('plan', 'deadbeef'))).code).toBe('not_found');
    expect((await failure(ada.boardAtRevision('plan', 'no-such-branch'))).code).toBe('not_found');
    expect((await api(server, 'GET', '/api/boards/plan/revisions/--output=x')).status).toBe(400);
  });

  it('says when a committed board file does not parse', async () => {
    await writeFile(projectPaths(root).boardFile('plan'), '{ "broken": ');
    await commit('Break it');
    const error = await failure(ada.boardAtRevision('plan', 'HEAD'));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('does not parse');
  });

  it('exports every format, and an SVG diff against a revision', async () => {
    for (const [format, mime, extension] of [
      ['json', 'application/json', '.json'],
      ['markdown', 'text/markdown', '.md'],
      ['mermaid', 'text/vnd.mermaid', '.mmd'],
      ['jsoncanvas', 'application/json', '.canvas'],
      ['svg', 'image/svg+xml', '.svg'],
    ] as const) {
      const res = await api(server, 'GET', `/api/boards/plan/export?format=${format}`);
      expect(res.status, format).toBe(200);
      expect(res.headers['content-type']).toBe(`${mime}; charset=utf-8`);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="plan${extension}"`);
      expect(res.text.length).toBeGreaterThan(20);
    }
    const diff = await ada.exportBoard('plan', {
      format: 'svg',
      diffFrom: 'HEAD~1',
      theme: 'dark',
    });
    expect(diff.filename).toBe('plan.diff.svg');
    expect(diff.mime).toBe('image/svg+xml');
    expect(diff.text).toContain('<svg');
    expect(diff.text).toContain('No rate limit');
    expect(diff.text).toContain('Write docs'); // drawn as removed
    expect(
      (await api(server, 'GET', '/api/boards/plan/export?format=mermaid&diffFrom=HEAD')).status,
    ).toBe(400);
    expect((await api(server, 'GET', '/api/boards/plan/export?format=pdf')).status).toBe(400);
  });
});

describe('import', () => {
  const MERMAID = [
    'flowchart TD',
    '  subgraph Pay[Payments]',
    '    A[Charge card] --> B(Send receipt)',
    '  end',
    '  B -.-> C{Refund?}',
    '  classDef hot fill:#f00',
    '  weird line that is not mermaid',
  ].join('\n');

  const CANVAS = JSON.stringify({
    nodes: [
      { id: 'g', type: 'group', x: 0, y: 0, width: 600, height: 400, label: 'Area' },
      { id: 't1', type: 'text', x: 20, y: 40, width: 200, height: 80, text: '# Idea\nMore text' },
      { id: 'f1', type: 'file', x: 300, y: 40, width: 200, height: 80, file: 'src/a.ts' },
    ],
    edges: [{ id: 'x', fromNode: 't1', toNode: 'f1', label: 'uses' }],
  });

  it('reads Mermaid into an existing board as one batch by the caller, with warnings', async () => {
    const result = await server.api(BOT).importInto('plan', { text: MERMAID });
    expect(result.status).toBe('applied');
    expect(result.format).toBe('mermaid');
    expect(result.warnings.join(' ')).toMatch(/skipped|not/i);
    const board = await ada.getBoard('plan');
    const titles = Object.values(board.nodes).map((n) => n.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Payments',
        'Charge card',
        'Send receipt',
        'Refund?',
        'Build the API',
      ]),
    );
    const [batch] = (await ada.history('plan')).batches;
    expect(batch).toMatchObject({
      actor: 'bot',
      reason: 'Import from mermaid',
      id: result.batchId,
    });
  });

  it('puts everything inside a frame, and reads JSON Canvas', async () => {
    await ada.apply('plan', {
      ops: [{ op: 'add_node', id: 'inbox', node: { type: 'frame', title: 'Inbox' } }],
    });
    const result = await ada.importInto('plan', {
      text: CANVAS,
      filename: 'notes.canvas',
      frame: 'inbox',
    });
    expect(result.status).toBe('applied');
    expect(result.format).toBe('jsoncanvas');
    const board = await ada.getBoard('plan');
    const area = Object.values(board.nodes).find((n) => n.title === 'Area');
    expect(area?.parent).toBe('inbox');
    const idea = Object.values(board.nodes).find((n) => n.title === 'Idea');
    expect(idea?.parent).toBe(area?.id);
    expect(Object.values(board.edges).some((e) => e.label === 'uses')).toBe(true);
  });

  it('checks without changing anything in a dry run, and refuses what it cannot read', async () => {
    const cursor = (await ada.outline('plan')).cursor;
    const dry = await ada.importInto('plan', { text: MERMAID, dryRun: true });
    expect(dry.status).toBe('valid');
    expect(dry.warnings.length).toBeGreaterThan(0);
    expect((await ada.outline('plan')).cursor).toBe(cursor);
    expect((await failure(ada.importInto('plan', { text: 'hello there' }))).code).toBe(
      'invalid_request',
    );
    expect((await failure(ada.importInto('plan', { text: '{}', format: 'json' }))).code).toBe(
      'invalid_request',
    );
    expect((await failure(ada.importInto('plan', { text: MERMAID, frame: 'api' }))).code).toBe(
      'invalid_request',
    );
    expect((await failure(ada.importInto('plan', { text: MERMAID, frame: 'none' }))).code).toBe(
      'not_found',
    );
  });
});
