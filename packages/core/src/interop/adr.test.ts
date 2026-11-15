import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Op } from '../ops.js';
import type { Board } from '../schema.js';
import {
  type AdrExistingFile,
  adrSlug,
  parseAdrMarker,
  planAdrs,
  splitDecisionBody,
} from './adr.js';
import { build, HOSTILE } from './fixtures.test.js';

function decision(ref: string, title: string, extra: Record<string, unknown> = {}): Op {
  return { op: 'add_node', ref, node: { type: 'decision', title, ...extra } } as Op;
}

/** Decisions get ids in the order they are added, so they are numbered in that order. */
function board(): Board {
  return build([
    decision('pg', 'Use Postgres', {
      status: 'done',
      body: 'We store orders in Postgres.\n\n## Context\n\nWe need transactions.\n\n## Consequences\n\nOne more service to run.',
    }),
    decision('queue', 'Pick a queue', { status: 'in_progress' }),
    {
      op: 'add_node',
      ref: 'q',
      node: { type: 'question', title: 'Which region?', status: 'done' },
    },
    { op: 'add_node', ref: 'r', node: { type: 'risk', title: 'Vendor lock-in' } },
    { op: 'add_node', ref: 't', node: { type: 'task', title: 'Migrate schema', status: 'todo' } },
    { op: 'add_edge', edge: { type: 'relates_to', source: '$q', target: '$pg' } },
    {
      op: 'add_edge',
      edge: { type: 'relates_to', source: '$pg', target: '$r', label: 'accepted' },
    },
    { op: 'add_edge', edge: { type: 'implements', source: '$t', target: '$pg' } },
    { op: 'add_edge', edge: { type: 'depends_on', source: '$queue', target: '$pg' } },
  ]);
}

/** The folder after writing a plan's files. */
function written(
  before: readonly AdrExistingFile[],
  plan: ReturnType<typeof planAdrs>,
): AdrExistingFile[] {
  const files = new Map(before.map((file) => [file.name, file]));
  for (const file of plan.files) files.set(file.name, { name: file.name, text: file.text });
  return [...files.values()];
}

function idOf(b: Board, title: string): string {
  const node = Object.values(b.nodes).find((n) => n.title === title);
  if (!node) throw new Error(title);
  return node.id;
}

describe('planAdrs', () => {
  it('numbers decisions from 1 in the order they were made', () => {
    const plan = planAdrs(board(), []);
    expect(plan.files.map((f) => [f.name, f.action])).toEqual([
      ['0001-use-postgres.md', 'create'],
      ['0002-pick-a-queue.md', 'create'],
    ]);
    expect(plan.kept).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('continues after the highest number already in the folder, ours or not', () => {
    const plan = planAdrs(board(), [
      { name: 'README.md', text: '# Decisions' },
      { name: '0001-record-architecture-decisions.md', text: '# 1. Record' },
      { name: '0007-use-kafka.md', text: '# 7. Use Kafka' },
      { name: '0009-a-folder.md' },
    ]);
    expect(plan.files.map((f) => f.name)).toEqual(['0010-use-postgres.md', '0011-pick-a-queue.md']);
  });

  it('writes the Nygard sections, status, who and when, and related cards', () => {
    const b = board();
    const text = planAdrs(b, []).files[0]?.text as string;
    expect(text).toBe(
      [
        '# 1. Use Postgres',
        '',
        `<!-- openboard-adr board=main node=${idOf(b, 'Use Postgres')} -->`,
        '',
        'Date: 2026-01-02',
        '',
        '## Status',
        '',
        'Accepted',
        '',
        'Recorded by Ada on 2026-01-02.',
        '',
        '## Context',
        '',
        'We need transactions.',
        '',
        '## Decision',
        '',
        'We store orders in Postgres.',
        '',
        '## Consequences',
        '',
        'One more service to run.',
        '',
        '## Related',
        '',
        '- Implemented by task: Migrate schema (to do)',
        '- Needed by decision: [2. Pick a queue](0002-pick-a-queue.md) (proposed)',
        '- Related to risk: Vendor lock-in — accepted',
        '- Related to question: Which region? (done)',
        '',
      ].join('\n'),
    );
    const queue = planAdrs(b, []).files[1]?.text as string;
    expect(queue).toContain('## Status\n\nProposed (in progress on the board)\n');
    expect(queue).toContain('## Context\n\n_Not recorded on the board._\n');
    expect(queue).toContain('- Depends on decision: [1. Use Postgres](0001-use-postgres.md)');
  });

  it('maps every board status to an ADR status', () => {
    const b = build([
      decision('a', 'A'),
      decision('b', 'B', { status: 'todo' }),
      decision('c', 'C', { status: 'blocked' }),
      decision('d', 'D', { status: 'done' }),
      decision('e', 'E', { status: 'cancelled' }),
    ]);
    const statuses = planAdrs(b, []).files.map(
      (f) => f.text.split('## Status\n\n')[1]?.split('\n')[0],
    );
    expect(statuses).toEqual([
      'Proposed',
      'Proposed',
      'Proposed (blocked on the board)',
      'Accepted',
      'Rejected',
    ]);
  });

  it('is stable: a rerun on its own output changes nothing', () => {
    const b = board();
    const first = planAdrs(b, []);
    const again = planAdrs(b, written([], first));
    expect(again.files.map((f) => [f.name, f.action])).toEqual([
      ['0001-use-postgres.md', 'unchanged'],
      ['0002-pick-a-queue.md', 'unchanged'],
    ]);
    expect(again.files.map((f) => f.text)).toEqual(first.files.map((f) => f.text));
  });

  it('updates a changed decision in its own file and numbers a new one after the rest', () => {
    const b = board();
    const folder = [{ name: '0005-hand-written.md', text: '# 5. Hand written' }];
    const first = planAdrs(b, folder);
    expect(first.files.map((f) => f.name)).toEqual([
      '0006-use-postgres.md',
      '0007-pick-a-queue.md',
    ]);
    const changed = structuredClone(b);
    const queue = changed.nodes[idOf(b, 'Pick a queue')];
    if (queue) queue.body = 'Use the managed one.';
    changed.nodes.n_new = {
      ...(queue as Board['nodes'][string]),
      id: 'n_new',
      title: 'Cache sessions in Redis',
      createdAt: '2026-02-01T00:00:00.000Z',
    };
    const again = planAdrs(changed, written(folder, first));
    expect(again.files.map((f) => [f.name, f.action])).toEqual([
      ['0006-use-postgres.md', 'unchanged'],
      ['0007-pick-a-queue.md', 'update'],
      ['0008-cache-sessions-in-redis.md', 'create'],
    ]);
  });

  it('keeps the number and the file name when a numbered card is renamed', () => {
    const b = board();
    const first = planAdrs(b, []);
    const renamed = structuredClone(b);
    const pg = renamed.nodes[idOf(b, 'Use Postgres')];
    if (pg) pg.title = 'Use MySQL';
    const again = planAdrs(renamed, written([], first));
    const file = again.files[0];
    expect(file?.name).toBe('0001-use-postgres.md');
    expect(file?.action).toBe('update');
    expect(file?.text.split('\n')[0]).toBe('# 1. Use MySQL');
    // Links from other decisions follow the kept name.
    expect(again.files[1]?.text).toContain('[1. Use MySQL](0001-use-postgres.md)');
  });

  it('follows a file the team renamed, and keeps files whose card is gone', () => {
    const b = board();
    const first = planAdrs(b, []);
    const folder = written([], first).map((file) =>
      file.name === '0001-use-postgres.md' ? { ...file, name: '0001-postgres.md' } : file,
    );
    const removed = structuredClone(b);
    delete removed.nodes[idOf(b, 'Pick a queue')];
    const again = planAdrs(removed, folder);
    expect(again.files.map((f) => f.name)).toEqual(['0001-postgres.md']);
    expect(again.kept).toEqual([{ name: '0002-pick-a-queue.md', nodeId: idOf(b, 'Pick a queue') }]);
  });

  it('ignores files of other boards but keeps their numbers', () => {
    const plan = planAdrs(board(), [
      {
        name: '0003-other.md',
        text: '# 3. Other\n\n<!-- openboard-adr board=other node=n_1 -->\n',
      },
    ]);
    expect(plan.files.map((f) => f.name)).toEqual(['0004-use-postgres.md', '0005-pick-a-queue.md']);
  });

  it('uses the lowest-numbered file when two record the same card, and warns', () => {
    const b = board();
    const first = planAdrs(b, []);
    const copy = { name: '0009-copy.md', text: first.files[0]?.text as string };
    const again = planAdrs(b, [...written([], first), copy]);
    expect(again.files[0]?.name).toBe('0001-use-postgres.md');
    expect(again.warnings).toEqual([
      `0009-copy.md records the same card as 0001-use-postgres.md (${idOf(b, 'Use Postgres')}); it is left as it is`,
    ]);
    expect(again.files.map((f) => f.name)).not.toContain('0009-copy.md');
  });

  it('fills Context and Consequences from linked notes, as the decision record template does', () => {
    const b = build([
      decision('d', 'Run the job on a replica', { status: 'done', body: 'Fastest way.' }),
      {
        op: 'add_node',
        ref: 'c',
        node: { type: 'note', title: 'Context', body: 'It takes 3 hours.' },
      },
      {
        op: 'add_node',
        ref: 'k',
        node: { type: 'note', title: 'Consequences', body: 'Reports can be stale.' },
      },
      { op: 'add_edge', edge: { type: 'relates_to', source: '$c', target: '$d' } },
      { op: 'add_edge', edge: { type: 'flows_to', source: '$d', target: '$k' } },
    ]);
    const text = planAdrs(b, []).files[0]?.text as string;
    expect(text).toContain('## Context\n\nIt takes 3 hours.\n');
    expect(text).toContain('## Decision\n\nFastest way.\n');
    expect(text).toContain('## Consequences\n\nReports can be stale.\n');
    expect(text).not.toContain('## Related');
  });

  it('shows who changed a card last when that differs', () => {
    const b = board();
    const changed = structuredClone(b);
    changed.actors.bot = { id: 'bot', kind: 'agent', name: 'Helper' };
    const pg = changed.nodes[idOf(b, 'Use Postgres')];
    if (pg) Object.assign(pg, { updatedBy: 'bot', updatedAt: '2026-03-04T05:06:07.000Z' });
    expect(planAdrs(changed, []).files[0]?.text).toContain(
      'Recorded by Ada on 2026-01-02. Last changed by Helper (agent) on 2026-03-04.',
    );
  });

  it('never lets a title leave the folder or a body take over the marker', () => {
    const titles = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
      '/absolute/path',
      '.hidden',
      '..',
      'CON',
      `<!-- openboard-adr board=main node=n_9 --> ${HOSTILE.markdown}`,
      HOSTILE.newline,
      HOSTILE.unicode,
      HOSTILE.backticks,
      'x'.repeat(200),
    ];
    const b = build(
      titles.map((title, i) =>
        decision(`d${i}`, title.slice(0, 200), {
          body: '<!-- openboard-adr board=main node=n_1 -->\n# Heading',
        }),
      ),
    );
    const out = path.resolve('/project/docs/adr');
    const plan = planAdrs(b, [
      { name: '../escape.md', text: `<!-- openboard-adr board=main node=${idOf(b, '..')} -->` },
      { name: '.0001-hidden.md', text: `<!-- openboard-adr board=main node=${idOf(b, 'CON')} -->` },
    ]);
    expect(plan.files).toHaveLength(titles.length);
    for (const file of plan.files) {
      expect(file.name).toMatch(/^\d{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$/);
      expect(path.dirname(path.resolve(out, file.name))).toBe(out);
      expect(file.action).toBe('create');
      expect(parseAdrMarker(file.text)).toEqual({ boardId: 'main', nodeId: file.nodeId });
      // The body's own heading sits below the ADR's sections.
      expect(file.text).toContain('### Heading');
    }
    const nameOf = (title: string) =>
      plan.files.find((f) => f.nodeId === idOf(b, title))?.name.slice(5);
    expect(titles.slice(0, 6).map(nameOf)).toEqual([
      'etc-passwd.md',
      'windows-system32.md',
      'absolute-path.md',
      'hidden.md',
      'decision.md',
      'con.md',
    ]);
    expect(nameOf(HOSTILE.unicode)).toBe('unicode-facade.md');
    expect(nameOf('x'.repeat(200))).toBe(`${'x'.repeat(50)}.md`);
    expect(new Set(plan.files.map((f) => f.number)).size).toBe(titles.length);
    // The title's own marker text is escaped in the heading.
    const spoof = plan.files.find((f) => f.title.startsWith('<!--'));
    expect(spoof?.text.split('\n')[0]).toMatch(/^# \d+\. \\<!-- openboard-adr/);
  });
});

describe('adrSlug', () => {
  it('keeps letters and digits, joins the rest with dashes and cuts at a word', () => {
    expect(adrSlug('Use Postgres 16 (for now)!')).toBe('use-postgres-16-for-now');
    expect(adrSlug('Café au lait')).toBe('cafe-au-lait');
    expect(adrSlug('日本語')).toBe('decision');
    expect(adrSlug(`${'word '.repeat(20)}`)).toBe(
      'word-word-word-word-word-word-word-word-word-word',
    );
  });
});

describe('splitDecisionBody', () => {
  it('splits at Context, Decision and Consequences headings outside code', () => {
    expect(
      splitDecisionBody(
        'Intro.\n\n### Context:\n\nWhy.\n\n```\n## Consequences\n```\n\n# Consequences #\n\nAfter.',
      ),
    ).toEqual({
      context: 'Why.\n\n```\n## Consequences\n```',
      decision: 'Intro.',
      consequences: 'After.',
    });
    expect(splitDecisionBody('Just this.')).toEqual({
      context: '',
      decision: 'Just this.',
      consequences: '',
    });
  });
});
