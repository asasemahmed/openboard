import { describe, expect, it } from 'vitest';
import { serializeBoard } from '../serialize.js';
import { applyToEmpty, richBoard } from './fixtures.test.js';
import { detectFormat, EXPORTERS, findExporter, findImporter, IMPORTERS } from './registry.js';

describe('EXPORTERS', () => {
  it('lists json, markdown, mermaid, jsoncanvas and svg, each rendering the board', () => {
    expect(EXPORTERS.map((e) => `${e.name}${e.extension}`)).toEqual([
      'json.json',
      'markdown.md',
      'mermaid.mmd',
      'jsoncanvas.canvas',
      'svg.svg',
    ]);
    const board = richBoard();
    for (const exporter of EXPORTERS) {
      const text = exporter.render(board);
      expect(text.length).toBeGreaterThan(100);
      expect(text.endsWith('\n')).toBe(true);
    }
    expect(findExporter('json')?.render(board)).toBe(serializeBoard(board));
  });

  it('passes plain options through', () => {
    const board = richBoard();
    expect(findExporter('mermaid')?.render(board, { direction: 'LR' })).toContain('flowchart LR');
    expect(findExporter('svg')?.render(board, { theme: 'dark', title: false })).toContain(
      '#121519',
    );
    expect(findExporter('markdown')?.render(board, { bodies: false })).not.toContain(
      'Stripe first.',
    );
  });
});

describe('IMPORTERS', () => {
  it('reads what the matching exporter writes, into ops that apply to an empty board', () => {
    const board = richBoard();
    for (const importer of IMPORTERS) {
      const exporter = findExporter(importer.name);
      const result = importer.parse(exporter?.render(board) ?? '');
      const back = applyToEmpty(result.ops);
      expect(Object.keys(back.nodes)).toHaveLength(Object.keys(board.nodes).length);
      expect(Object.keys(back.edges)).toHaveLength(Object.keys(board.edges).length);
    }
    expect(findImporter('mermaid')?.extensions).toEqual(['.mmd', '.mermaid']);
    expect(findImporter('jsoncanvas')?.extensions).toEqual(['.canvas']);
  });
});

describe('detectFormat', () => {
  it('recognises contents first, then the extension', () => {
    const board = richBoard();
    expect(detectFormat('x.txt', serializeBoard(board))).toBe('json');
    expect(detectFormat('x.txt', '{"nodes": [], "edges": []}')).toBe('jsoncanvas');
    expect(detectFormat('x.txt', '%% hi\n\ngraph TD\nA-->B')).toBe('mermaid');
    expect(detectFormat('x.txt', '---\ntitle: x\n---\nflowchart LR')).toBe('mermaid');
    expect(detectFormat('x.txt', '<?xml version="1.0"?>\n<svg></svg>')).toBe('svg');
    expect(detectFormat('Plan.CANVAS', '')).toBe('jsoncanvas');
    expect(detectFormat('a.mermaid', 'A --> B')).toBe('mermaid');
    expect(detectFormat('main.board.json', '')).toBe('json');
    expect(detectFormat('notes.md', '# Title')).toBe('markdown');
    expect(detectFormat('data.json', '{"a": 1}')).toBe('json');
    expect(detectFormat('unknown.bin', 'hello')).toBeUndefined();
    expect(detectFormat('x', '{broken')).toBeUndefined();
  });
});
