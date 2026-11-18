import { describe, expect, it } from 'vitest';
import { parsePastedLines, pasteLinesOps } from './pasteLines.js';

describe('parsePastedLines', () => {
  it('parses plain, bulleted, numbered, and checkbox lines', () => {
    const cards = parsePastedLines(
      [
        '',
        '  Plain thought  ',
        '- Bullet item',
        '* Star item',
        '1. First step',
        '2) Second step',
        '[ ] Todo task',
        '- [x] Done task',
        '- [X] Also done',
        '   ',
      ].join('\n'),
    );
    expect(cards).toEqual([
      { type: 'note', title: 'Plain thought' },
      { type: 'note', title: 'Bullet item' },
      { type: 'note', title: 'Star item' },
      { type: 'note', title: 'First step' },
      { type: 'note', title: 'Second step' },
      { type: 'task', title: 'Todo task', status: 'todo' },
      { type: 'task', title: 'Done task', status: 'done' },
      { type: 'task', title: 'Also done', status: 'done' },
    ]);
  });
});

describe('pasteLinesOps', () => {
  it('lays out cards in a column in one batch', () => {
    const cards = parsePastedLines('Alpha\n[ ] Beta');
    let seq = 0;
    const { ops, ids } = pasteLinesOps(cards, { x: 200, y: 100 }, new Map(), () => `n_${++seq}`);
    expect(ids).toEqual(['n_1', 'n_2']);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      op: 'add_node',
      id: 'n_1',
      node: { type: 'note', title: 'Alpha' },
    });
    expect(ops[1]).toMatchObject({
      op: 'add_node',
      id: 'n_2',
      node: { type: 'task', title: 'Beta', status: 'todo' },
    });
    const y1 = (ops[0] as { node: { view: { y: number } } }).node.view.y;
    const y2 = (ops[1] as { node: { view: { y: number } } }).node.view.y;
    expect(y2).toBeGreaterThan(y1);
  });
});
