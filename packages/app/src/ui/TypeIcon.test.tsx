import { applyOps, emptyBoard, toSvg } from '@openboard/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BuiltinTypeIcon, hasBuiltinTypeIcon, TypeIcon } from './TypeIcon.js';

const types = ['note', 'task', 'decision', 'question', 'risk', 'doc', 'code', 'agent', 'run'];

function shapes(markup: string): string {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = markup;
  return wrapper.querySelector('svg')?.innerHTML ?? '';
}

describe('built-in type glyphs', () => {
  it.each(types)('preserves the %s drawing in the canvas and SVG export', (type) => {
    const drawing = shapes(renderToStaticMarkup(<BuiltinTypeIcon type={type} />));
    expect(drawing).toMatchSnapshot();
    const result = applyOps(
      emptyBoard({ id: 'icons', name: 'Icons' }),
      [{ op: 'add_node', node: { type, title: type } }],
      { actor: { id: 'ada', kind: 'human', name: 'Ada' } },
    );
    if (!result.ok) throw new Error('Could not build glyph fixture');
    for (const theme of ['light', 'dark'] as const) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = toSvg(result.board, { theme });
      const glyph = wrapper.querySelector('g[transform*="scale(0.875)"]');
      expect(glyph?.innerHTML).toBe(drawing);
    }
  });

  it.each(['frame', 'x:custom', 'constructor', '__proto__'])(
    'has no built-in glyph for %s',
    (type) => {
      expect(hasBuiltinTypeIcon(type)).toBe(false);
      expect(renderToStaticMarkup(<BuiltinTypeIcon type={type} />)).toBe('');
    },
  );

  it('keeps declared icons that share a built-in drawing unchanged', () => {
    for (const [name, type] of [
      ['alert', 'risk'],
      ['file', 'doc'],
      ['bot', 'agent'],
    ] as const) {
      expect(shapes(renderToStaticMarkup(<TypeIcon name={name} />))).toBe(
        shapes(renderToStaticMarkup(<BuiltinTypeIcon type={type} />)),
      );
    }
  });
});
