/** Plain SVG geometry on a 16px grid, shared by the canvas and SVG export. */
export type TypeGlyphElement =
  | { readonly tag: 'path'; readonly attrs: { readonly d: string } }
  | {
      readonly tag: 'circle';
      readonly attrs: { readonly cx: string; readonly cy: string; readonly r: string };
    }
  | {
      readonly tag: 'rect';
      readonly attrs: {
        readonly x: string;
        readonly y: string;
        readonly width: string;
        readonly height: string;
        readonly rx: string;
      };
    };

/** Frames and custom types have no built-in glyph. */
export const BUILTIN_TYPE_GLYPHS: Readonly<Record<string, readonly TypeGlyphElement[]>> = {
  note: [
    { tag: 'path', attrs: { d: 'M2.75 2.75h10.5v6.5l-4 4h-6.5z' } },
    { tag: 'path', attrs: { d: 'M13.25 9.25h-4v4' } },
  ],
  task: [
    { tag: 'rect', attrs: { x: '2.5', y: '2.5', width: '11', height: '11', rx: '3' } },
    { tag: 'path', attrs: { d: 'M5.5 8.25l1.75 1.75 3.25-3.75' } },
  ],
  decision: [
    { tag: 'path', attrs: { d: 'M8 1.75L14.25 8 8 14.25 1.75 8z' } },
    { tag: 'path', attrs: { d: 'M6 8h4M8.5 6.5L10 8 8.5 9.5' } },
  ],
  question: [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '5.75' } },
    { tag: 'path', attrs: { d: 'M6.4 6.5a1.7 1.7 0 113 1.1c-.6.5-1.4.8-1.4 1.65M8 11.25v.01' } },
  ],
  risk: [
    { tag: 'path', attrs: { d: 'M8 2.25l6 10.5H2z' } },
    { tag: 'path', attrs: { d: 'M8 6.5v2.75M8 11.25v.01' } },
  ],
  doc: [
    { tag: 'path', attrs: { d: 'M4 1.75h5l3.5 3.5v9H4z' } },
    { tag: 'path', attrs: { d: 'M9 1.75v3.5h3.5M6 8.5h4M6 11h4' } },
  ],
  code: [{ tag: 'path', attrs: { d: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5' } }],
  agent: [
    { tag: 'rect', attrs: { x: '2.75', y: '5', width: '10.5', height: '8', rx: '2' } },
    { tag: 'path', attrs: { d: 'M8 2.5V5M6 9h.01M10 9h.01M6.5 11.25h3' } },
  ],
  run: [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '5.75' } },
    { tag: 'path', attrs: { d: 'M6.75 5.75v4.5L10.5 8z' } },
  ],
};

export function builtinTypeGlyph(type: string): readonly TypeGlyphElement[] | undefined {
  return Object.hasOwn(BUILTIN_TYPE_GLYPHS, type) ? BUILTIN_TYPE_GLYPHS[type] : undefined;
}
