import {
  type Board,
  BoardDoc,
  type BoardNode,
  diffBoards,
  type ImportIntoResult,
  type Link,
  type RevisionsResult,
} from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { codeMarker, linkViews, localState, outOfDate } from './codeLinks.js';
import { deriveDiffView, diffSummary } from './diffView.js';
import { absolutePath, editorUrl, lineRange, linkTargetProblem, safeHttpUrl } from './editor.js';
import {
  importable,
  importReducer,
  importRequest,
  initialImport,
  warningsOf,
} from './importFlow.js';
import { revisionPicker } from './revisions.js';

describe('editor URLs', () => {
  it('opens a project file at a line in each editor', () => {
    expect(editorUrl('vscode', '/Users/ada/work', 'src/a.ts', 12)).toBe(
      'vscode://file/Users/ada/work/src/a.ts:12',
    );
    expect(editorUrl('cursor', '/Users/ada/work/', './src/a.ts')).toBe(
      'cursor://file/Users/ada/work/src/a.ts',
    );
    expect(editorUrl('zed', '/w', 'src/api.ts#createUser', 3, 'symbol')).toBe(
      'zed://file/w/src/api.ts:3',
    );
    expect(editorUrl('copy', '/w', 'src/a.ts')).toBeNull();
  });

  it('encodes spaces and #, and keeps Windows drive letters', () => {
    expect(editorUrl('vscode', '/Users/ada/My Work', 'docs/C# notes.md')).toBe(
      'vscode://file/Users/ada/My%20Work/docs/C%23%20notes.md',
    );
    expect(editorUrl('vscode', '/w', 'docs/a b%c.md', 2)).toBe(
      'vscode://file/w/docs/a%20b%25c.md:2',
    );
    expect(editorUrl('vscode', 'C:\\Users\\ada\\work', 'src\\a.ts', 4)).toBe(
      'vscode://file/C:/Users/ada/work/src/a.ts:4',
    );
  });

  it('never opens anything outside the project', () => {
    expect(absolutePath('/w', '../secrets.txt')).toBeNull();
    expect(absolutePath('/w', 'src/../../etc/passwd')).toBeNull();
    expect(absolutePath('/w', '/etc/passwd')).toBeNull();
    expect(absolutePath('/w', 'C:/Windows/win.ini')).toBeNull();
    expect(absolutePath('/w', 'file:///etc/passwd')).toBeNull();
    expect(editorUrl('vscode', '/w', '../x')).toBeNull();
  });

  it('checks a new link’s target and words line ranges', () => {
    expect(linkTargetProblem('file', '')).toBe('Enter a path.');
    expect(linkTargetProblem('file', '/Users/ada/a.ts')).toMatch(/relative to the project root/);
    expect(linkTargetProblem('file', '../a.ts')).toMatch(/climbs out/);
    expect(linkTargetProblem('symbol', 'src/a.ts')).toMatch(/after a #/);
    expect(linkTargetProblem('file', 'src/a.ts')).toBeNull();
    expect(linkTargetProblem('url', 'javascript:alert(1)')).toMatch(/http or https/);
    expect(linkTargetProblem('url', 'https://example.com')).toBeNull();
    expect(lineRange(3, 5)).toBe('3–5');
    expect(lineRange(3, 3)).toBe('3');
    expect(lineRange()).toBe('');
    expect(safeHttpUrl('ftp://x')).toBeNull();
  });
});

describe('link states', () => {
  const file = (over: Partial<Link> = {}): Link => ({ kind: 'file', target: 'src/a.ts', ...over });

  it('reads the live state from the document', () => {
    expect(localState(file({ hash: 'sha256:1' }))).toBe('ok');
    expect(localState(file({ hash: 'sha256:1', stale: true }))).toBe('stale');
    expect(localState(file())).toBe('unchecked');
    expect(localState({ kind: 'url', target: 'https://x', stale: true })).toBe('unchecked');
  });

  it('marks cards with changed code, and offers what fits each state', () => {
    const node = {
      id: 'n1',
      links: [
        file({ hash: 'h', stale: true, line: 3, endLine: 5 }),
        file({ target: 'gone.ts', hash: 'h', stale: true }),
        file({ target: '/etc/passwd' }),
        { kind: 'url' as const, target: 'https://example.com' },
      ],
    };
    expect(outOfDate(node)).toBe(2);
    expect(codeMarker(node)?.label).toBe('Code changed');
    expect(codeMarker({ links: [file({ hash: 'h' })] })).toBeNull();
    const views = linkViews(node, [
      {
        nodeId: 'n1',
        title: 'T',
        index: 0,
        link: node.links[0] as Link,
        state: 'stale',
        detail: 'content changed at lines 3-5',
      },
      {
        nodeId: 'n1',
        title: 'T',
        index: 1,
        link: node.links[1] as Link,
        state: 'missing',
        detail: 'file missing',
      },
      {
        nodeId: 'n1',
        title: 'T',
        index: 2,
        link: node.links[2] as Link,
        state: 'outside',
        detail: 'outside the project',
      },
    ]);
    expect(views.map((v) => [v.state, v.status, v.canOpen, v.canRefresh, v.warn])).toEqual([
      ['stale', 'Content changed at lines 3-5', true, true, true],
      ['missing', 'File missing', true, true, true],
      ['outside', 'Outside the project', false, false, true],
      ['unchecked', '', false, false, false],
    ]);
  });

  it('trusts the document over an older server answer once a link is fresh again', () => {
    const fresh = file({ hash: 'h2' });
    const [view] = linkViews({ id: 'n1', links: [fresh] }, [
      { nodeId: 'n1', title: 'T', index: 0, link: fresh, state: 'stale', detail: 'old news' },
    ]);
    expect(view?.state).toBe('ok');
  });
});

describe('import flow', () => {
  const ok = (over: Partial<ImportIntoResult> = {}): ImportIntoResult => ({
    status: 'valid',
    cursor: 1,
    refs: { a: 'n_a', b: 'n_b' },
    applied: {
      refs: {},
      addedNodes: ['n_a', 'n_b'],
      updatedNodes: [],
      removedNodes: [],
      addedEdges: ['e_1'],
      updatedEdges: [],
      removedEdges: [],
    },
    format: 'mermaid',
    warnings: ['Skipped a click handler on line 3'],
    ...over,
  });

  it('detects, checks without changing anything, then imports', () => {
    let s = initialImport({ frame: 'f1' });
    s = importReducer(s, {
      type: 'text',
      text: 'flowchart TD\nA-->B',
      filename: 'plan.mmd',
      detected: 'mermaid',
    });
    expect(s.frame).toBe('f1');
    s = importReducer(s, { type: 'check' });
    expect(s.step).toBe('checking');
    expect(importRequest(s, true)).toEqual({
      text: 'flowchart TD\nA-->B',
      dryRun: true,
      format: 'mermaid',
      filename: 'plan.mmd',
      frame: 'f1',
    });
    s = importReducer(s, { type: 'checked', result: ok() });
    expect(s.step).toBe('preview');
    expect(s.preview).toEqual({
      counts: { nodes: 2, edges: 1 },
      warnings: ['Skipped a click handler on line 3'],
    });
    s = importReducer(s, { type: 'confirm' });
    expect(s.step).toBe('importing');
    s = importReducer(s, { type: 'imported', result: ok({ status: 'applied' }) });
    expect(s.step).toBe('done');
    expect(s.result?.nodeIds).toEqual(['n_a', 'n_b']);
  });

  it('lets the person override the format, and asks when nothing can be told', () => {
    let s = importReducer(initialImport(), { type: 'text', text: 'A --> B', detected: null });
    s = importReducer(s, { type: 'check' });
    expect(s.step).toBe('edit');
    expect(s.error?.message).toMatch(/Pick Mermaid or JSON Canvas/);
    s = importReducer(s, { type: 'format', format: 'mermaid' });
    expect(s.error).toBeNull();
    expect(importReducer(s, { type: 'check' }).step).toBe('checking');
    expect(importable('svg')).toBeNull();
  });

  it('keeps warnings with every error, never a blank failure', () => {
    let s = importReducer(initialImport(), {
      type: 'text',
      text: 'flowchart TD',
      detected: 'mermaid',
    });
    s = importReducer(s, { type: 'check' });
    const empty = importReducer(s, {
      type: 'checked',
      result: ok({
        applied: {
          ...(ok().applied as NonNullable<ImportIntoResult['applied']>),
          addedNodes: [],
          addedEdges: [],
        },
        refs: {},
      }),
    });
    expect(empty.error).toEqual({
      message: 'Nothing in this text can be imported.',
      warnings: ['Skipped a click handler on line 3'],
    });
    const failed = importReducer(s, {
      type: 'failed',
      message: 'Nothing could be read.',
      warnings: ['Line 1: unknown shape'],
    });
    expect(failed).toMatchObject({ step: 'edit', error: { warnings: ['Line 1: unknown shape'] } });
    expect(warningsOf({ warnings: ['a', 3] })).toEqual(['a']);
    expect(warningsOf(['b'])).toEqual(['b']);
  });
});

const meta = { id: 'b', name: 'B' };
const t = '2026-01-01T00:00:00.000Z';
const node = (id: string, over: Partial<BoardNode> = {}): BoardNode => ({
  id,
  type: 'task',
  title: id,
  createdBy: 'a',
  createdAt: t,
  updatedBy: 'a',
  updatedAt: t,
  ...over,
});

function board(nodes: BoardNode[]): Board {
  const doc = BoardDoc.create(meta, { now: new Date(t) });
  const json = doc.toJSON();
  return { ...json, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: {} };
}

describe('diff view', () => {
  const before = board([
    node('frame', { type: 'frame', view: { x: 100, y: 100, w: 400, h: 300 } }),
    node('gone-frame', { type: 'frame', view: { x: 600, y: 50, w: 300, h: 200 } }),
    node('in-gone', { parent: 'gone-frame', view: { x: 20, y: 40 } }),
    node('in-kept', { parent: 'frame', view: { x: 10, y: 20 } }),
    node('old-parent', { type: 'frame', view: { x: 1000, y: 10, w: 300, h: 200 } }),
    node('orphan', { parent: 'old-parent', view: { x: 5, y: 6 } }),
    node('edited', { title: 'Old title', status: 'todo' }),
    node('moved', { view: { x: 0, y: 0 } }),
  ]);
  const after = board([
    node('frame', { type: 'frame', view: { x: 100, y: 100, w: 400, h: 300 } }),
    node('old-parent', { type: 'note', view: { x: 1000, y: 10 } }),
    node('edited', { title: 'New title', status: 'done', updatedAt: '2026-02-01T00:00:00.000Z' }),
    node('moved', { view: { x: 50, y: 0 } }),
    node('new'),
  ]);
  const view = deriveDiffView(diffBoards(before, after), before, after);

  it('marks what was added, updated and moved, with readable fields', () => {
    expect(view.marks.get('new')?.kind).toBe('added');
    expect(view.marks.get('edited')).toMatchObject({
      kind: 'updated',
      fields: ['Status', 'Title'],
    });
    expect(view.marks.get('edited')?.changes).toContainEqual({
      field: 'title',
      name: 'Title',
      before: 'Old title',
      after: 'New title',
    });
    expect(view.marks.get('moved')?.kind).toBe('moved');
    expect(view.counts).toEqual({ added: 1, updated: 2, moved: 1, removed: 4 });
    expect(diffSummary(view.counts)).toBe('1 added, 2 updated, 1 moved, 4 removed');
  });

  it('places removed nodes where they were', () => {
    const ghost = (id: string) => view.ghostNodes.find((n) => n.id === id);
    // In a frame that is still there: relative to it, as before.
    expect(ghost('in-kept')).toMatchObject({ parent: 'frame', view: { x: 10, y: 20 } });
    // In a frame removed with it: inside that frame's ghost.
    expect(ghost('in-gone')).toMatchObject({ parent: 'gone-frame' });
    // In a node that is no longer a frame: at its old canvas position, out of the stranger.
    expect(ghost('orphan')?.parent).toBeUndefined();
    expect(ghost('orphan')?.view).toMatchObject({ x: 1005, y: 16 });
  });

  it('knows what the diff touches, for "only changes"', () => {
    expect(view.touched.has('new')).toBe(true);
    expect(view.touched.has('in-gone')).toBe(true);
    expect(view.touched.has('frame')).toBe(false);
    expect(view.entries[0]?.kind).toBe('added');
    expect(view.entries.at(-1)?.kind).toBe('removed');
  });
});

describe('revision picker', () => {
  const result = (over: Partial<RevisionsResult>): RevisionsResult => ({
    boardId: 'b',
    tracked: true,
    dirty: false,
    revisions: [],
    text: '',
    ...over,
  });
  it('says when the board is not in git, has no commits, or has uncommitted changes', () => {
    expect(revisionPicker(result({ tracked: false }))).toEqual({ state: 'untracked' });
    expect(revisionPicker(result({ dirty: true }))).toEqual({ state: 'empty', dirty: true });
    const rev = { rev: 'abc', short: 'abc', at: t, author: 'Ada', subject: 'Plan' };
    expect(revisionPicker(result({ dirty: true, revisions: [rev] }))).toEqual({
      state: 'list',
      dirty: true,
      revisions: [rev],
    });
  });
});
