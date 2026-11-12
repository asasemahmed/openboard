/**
 * The node type <-> Mermaid shape table, shared by export and import. Each
 * built-in type has its own shape, so a diagram exported here comes back with
 * the same types. The plain rectangle is what hand-written diagrams use most,
 * so it stands for `note`, the type with the least meaning; custom types are
 * exported as rectangles too.
 */

export interface Shape {
  name: string;
  open: string;
  close: string;
}

export const SHAPES = {
  rect: { name: 'rect', open: '[', close: ']' },
  round: { name: 'round', open: '(', close: ')' },
  rhombus: { name: 'rhombus', open: '{', close: '}' },
  hexagon: { name: 'hexagon', open: '{{', close: '}}' },
  asymmetric: { name: 'asymmetric', open: '>', close: ']' },
  parallelogram: { name: 'parallelogram', open: '[/', close: '/]' },
  parallelogramAlt: { name: 'parallelogramAlt', open: '[\\', close: '\\]' },
  subroutine: { name: 'subroutine', open: '[[', close: ']]' },
  stadium: { name: 'stadium', open: '([', close: '])' },
  trapezoid: { name: 'trapezoid', open: '[/', close: '\\]' },
  trapezoidAlt: { name: 'trapezoidAlt', open: '[\\', close: '/]' },
  cylinder: { name: 'cylinder', open: '[(', close: ')]' },
  circle: { name: 'circle', open: '((', close: '))' },
  doubleCircle: { name: 'doubleCircle', open: '(((', close: ')))' },
} as const satisfies Record<string, Shape>;

export type ShapeName = keyof typeof SHAPES;

export const SHAPE_BY_TYPE: Record<string, ShapeName> = {
  note: 'rect',
  task: 'round',
  decision: 'rhombus',
  question: 'hexagon',
  risk: 'asymmetric',
  doc: 'parallelogram',
  code: 'subroutine',
  agent: 'stadium',
  run: 'trapezoid',
};

/** Shapes that map back to exactly one type; every other shape imports as `note`. */
export const TYPE_BY_SHAPE: Partial<Record<ShapeName, string>> = Object.fromEntries(
  Object.entries(SHAPE_BY_TYPE).map(([type, shape]) => [shape, type]),
);

/**
 * Openers in the order a parser must try them: longer delimiters first, so
 * `[[` is not read as `[`.
 */
export const OPENERS: readonly Shape[] = Object.values(SHAPES)
  .slice()
  .sort((a, b) => b.open.length - a.open.length || b.close.length - a.close.length);

/** `@{ shape: ... }` names (Mermaid 11) that have an unambiguous type. */
export const TYPE_BY_SHAPE_KEYWORD: Record<string, string> = {
  rect: 'note',
  rectangle: 'note',
  proc: 'note',
  process: 'note',
  rounded: 'task',
  event: 'task',
  diam: 'decision',
  diamond: 'decision',
  decision: 'decision',
  question: 'decision',
  hex: 'question',
  hexagon: 'question',
  prepare: 'question',
  odd: 'risk',
  doc: 'doc',
  document: 'doc',
  docs: 'doc',
  documents: 'doc',
  'lean-r': 'doc',
  'lean-right': 'doc',
  fr: 'code',
  'fr-rect': 'code',
  subproc: 'code',
  subroutine: 'code',
  'framed-rectangle': 'code',
  stadium: 'agent',
  pill: 'agent',
  terminal: 'agent',
  'trap-b': 'run',
  trapezoid: 'run',
  priority: 'run',
};
