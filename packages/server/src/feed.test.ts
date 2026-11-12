import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Actor, BoardDoc } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeFeed } from './feed.js';
import { removeRoot, tempRoot } from './testing.js';

const ACTOR: Actor = { id: 'helper', kind: 'agent', name: 'Helper' };

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await tempRoot();
  file = path.join(dir, 'plan.changes.jsonl');
});
afterEach(() => removeRoot(dir));

function addNotes(doc: BoardDoc, count: number, from = 0) {
  const ops = Array.from({ length: count }, (_, i) => ({
    op: 'add_node' as const,
    node: { type: 'note' as const, title: `Note ${from + i}` },
  }));
  const outcome = doc.apply(ops, { actor: ACTOR });
  if (!outcome.ok) throw new Error('apply failed');
}

describe('ChangeFeed', () => {
  it('numbers changes, attributes them, and restores the cursor from disk', async () => {
    const doc = BoardDoc.create({ id: 'plan', name: 'Plan' });
    const feed = await ChangeFeed.open(file);
    feed.attach(doc);
    addNotes(doc, 3);
    expect(feed.cursor).toBe(3);
    const { entries, resync } = feed.since(0);
    expect(resync).toBe(false);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries.every((e) => e.actor === 'helper' && e.kind === 'node_added')).toBe(true);
    await feed.flush();

    // A torn last line from a crash is skipped.
    await writeFile(file, `${await readFile(file, 'utf8')}{"seq":4,"at`);
    const reopened = await ChangeFeed.open(file);
    expect(reopened.cursor).toBe(3);
    expect(reopened.since(1).entries.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('asks for a resync when history is gone or the cursor is from the future', async () => {
    const doc = BoardDoc.create({ id: 'plan', name: 'Plan' });
    const feed = await ChangeFeed.open(file, { retain: 5 });
    feed.attach(doc);
    addNotes(doc, 8);
    expect(feed.cursor).toBe(8);
    expect(feed.since(2).resync).toBe(true);
    expect(feed.since(3).resync).toBe(false);
    expect(feed.since(3).entries).toHaveLength(5);
    expect(feed.since(8)).toEqual({ entries: [], resync: false });
    expect(feed.since(9).resync).toBe(true);
  });

  it('compacts the file so it does not grow without bound', async () => {
    const doc = BoardDoc.create({ id: 'plan', name: 'Plan' });
    const feed = await ChangeFeed.open(file, { retain: 4 });
    feed.attach(doc);
    for (let i = 0; i < 6; i++) addNotes(doc, 3, i * 3);
    await feed.flush();
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(8 + 3);
    const reopened = await ChangeFeed.open(file, { retain: 4 });
    expect(reopened.cursor).toBe(18);
  });
});
