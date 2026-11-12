import { describe, expect, it } from 'vitest';
import {
  type Actor,
  applyOps,
  type Board,
  checkBoardAgainstTypes,
  checkOpsAgainstTypes,
  DEFAULT_CONFIG,
  emptyBoard,
  type FieldDef,
  mergeTypes,
  type NodeTypeDef,
  type Op,
  type ProjectConfig,
  ProjectConfigSchema,
  parseConfig,
  renderOutline,
  renderRead,
  renderSchema,
  serializeConfig,
  TYPE_COLORS,
  TYPE_ICONS,
  type TypeRegistry,
} from './index.js';

const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };

const BUG: NodeTypeDef = {
  label: 'Bug',
  description: 'A defect someone found.',
  color: 'red',
  icon: 'bug',
  fields: [
    {
      key: 'severity',
      label: 'Severity',
      kind: 'select',
      options: ['low', 'medium', 'high'],
      required: true,
    },
    { key: 'summary', label: 'Summary', kind: 'text' },
    { key: 'steps', label: 'Steps', kind: 'longtext' },
    { key: 'points', label: 'Points', kind: 'number' },
    { key: 'regression', label: 'Regression', kind: 'boolean' },
    { key: 'found', label: 'Found on', kind: 'date' },
    { key: 'ticket', label: 'Ticket', kind: 'url' },
  ],
};

const PERSONA: NodeTypeDef = {
  label: 'Persona',
  hasStatus: false,
  fields: [{ key: 'role', label: 'Role', kind: 'text', required: true }],
};

function registry(nodeTypes: Record<string, NodeTypeDef>): TypeRegistry {
  return mergeTypes({ nodeTypes }).types;
}

const TYPES = registry({ 'x:bug': BUG, 'x:persona': PERSONA });

function counter() {
  let i = 0;
  return (prefix: string) => `${prefix}_${++i}`;
}

/** Apply `ops` (they must pass core validation), then check them against `types`. */
function check(board: Board, ops: Op[], types: TypeRegistry = TYPES) {
  const outcome = applyOps(board, ops, { actor: ada, newId: counter() });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.errors));
  return { errors: checkOpsAgainstTypes(board, ops, outcome.applied.refs, types), outcome };
}

const addBug = (props: Record<string, unknown>, extra: Record<string, unknown> = {}): Op =>
  ({
    op: 'add_node',
    ref: 'b',
    node: { type: 'x:bug', title: 'Login fails', props, ...extra },
  }) as Op;

const empty = () => emptyBoard({ id: 'b', name: 'B' });

describe('type definitions in config.json', () => {
  const config: ProjectConfig = {
    ...DEFAULT_CONFIG,
    nodeTypes: { 'x:persona': PERSONA, 'x:bug': BUG },
    edgeTypes: {
      'x:mitigates': { label: 'Mitigates', style: 'dashed', directed: true },
      'x:alias': { label: 'Alias of', directed: false },
    },
  };

  it('round-trip deterministically, with types sorted and fields in their order', () => {
    const text = serializeConfig(config);
    expect(serializeConfig(parseConfig(text))).toBe(text);
    const reordered: ProjectConfig = {
      ...config,
      nodeTypes: { 'x:bug': BUG, 'x:persona': PERSONA },
    };
    expect(serializeConfig(reordered)).toBe(text);
    expect(text.indexOf('"x:bug"')).toBeLessThan(text.indexOf('"x:persona"'));
    expect(text.indexOf('"severity"')).toBeLessThan(text.indexOf('"summary"'));
    expect(text.indexOf('"x:alias"')).toBeLessThan(text.indexOf('"x:mitigates"'));
    expect(parseConfig(text)).toEqual(ProjectConfigSchema.parse(config));
  });

  it('leaves a config without types byte for byte as before', () => {
    expect(serializeConfig(DEFAULT_CONFIG)).toBe(
      '{\n  "version": 1,\n  "policy": {\n    "default": "review_destructive",\n    "agents": {}\n  }\n}\n',
    );
    expect(serializeConfig({ ...DEFAULT_CONFIG, nodeTypes: {}, edgeTypes: {} })).toBe(
      serializeConfig(DEFAULT_CONFIG),
    );
  });

  const invalid = (nodeTypes: unknown) =>
    ProjectConfigSchema.safeParse({ ...DEFAULT_CONFIG, nodeTypes }).success;

  it('refuses names, colours, icons and fields that are not allowed', () => {
    expect(invalid({ bug: { label: 'Bug' } })).toBe(false);
    expect(invalid({ 'x:bug': { label: 'Bug', color: 'mauve' } })).toBe(false);
    expect(invalid({ 'x:bug': { label: 'Bug', icon: 'rocket-ship' } })).toBe(false);
    expect(invalid({ 'x:bug': { label: '' } })).toBe(false);
    const field = (f: Partial<FieldDef>) => ({
      'x:bug': { label: 'Bug', fields: [{ key: 'a', label: 'A', kind: 'text', ...f }] },
    });
    expect(invalid(field({ kind: 'select' }))).toBe(false);
    expect(invalid(field({ options: ['x'] }))).toBe(false);
    expect(invalid(field({ kind: 'select', options: ['x', 'x'] }))).toBe(false);
    expect(invalid(field({ key: 'Not-an-identifier' }))).toBe(false);
    expect(
      invalid({
        'x:bug': {
          label: 'Bug',
          fields: [
            { key: 'a', label: 'A', kind: 'text' },
            { key: 'a', label: 'B', kind: 'number' },
          ],
        },
      }),
    ).toBe(false);
    expect(invalid({ 'x:bug': BUG })).toBe(true);
    expect(TYPE_COLORS).toContain('teal');
    expect(TYPE_ICONS.length).toBe(24);
  });

  it('caps the number of types and fields', () => {
    const many = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`x:t${i}`, { label: `T${i}` }]),
    );
    expect(invalid(many)).toBe(false);
    const fields = Array.from({ length: 31 }, (_, i) => ({
      key: `f${i}`,
      label: `F${i}`,
      kind: 'text',
    }));
    expect(invalid({ 'x:bug': { label: 'Bug', fields } })).toBe(false);
  });
});

describe('checking ops against declared types', () => {
  const valid = {
    severity: 'high',
    summary: 'Cannot log in',
    steps: 'Open the page\nPress log in',
    points: 3,
    regression: true,
    found: '2026-11-12',
    ticket: 'https://example.com/T-1',
  };

  it('accepts a node whose fields all fit', () => {
    expect(check(empty(), [addBug(valid)]).errors).toEqual([]);
  });

  it.each([
    ['severity', 'urgent', 'props.severity must be one of low, medium, high (got "urgent")'],
    ['summary', 42, 'props.summary must be a string'],
    ['summary', 'two\nlines', 'props.summary must be one line'],
    ['steps', ['a'], 'props.steps must be a string'],
    ['points', 'three', 'props.points must be a number'],
    ['regression', 'yes', 'props.regression must be true or false'],
    ['found', '2026-02-30', 'props.found must be an ISO date'],
    ['found', '12/11/2026', 'props.found must be an ISO date'],
    ['ticket', 'javascript:alert(1)', 'props.ticket must be an http or https URL'],
    ['ticket', 'not a url', 'props.ticket must be an http or https URL'],
  ])('refuses %s = %j', (key, value, message) => {
    const { errors } = check(empty(), [addBug({ ...valid, [key]: value })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ index: 0, code: 'invalid' });
    expect(errors[0]?.message).toContain(message);
    expect(errors[0]?.message).toContain('x:bug');
  });

  it('refuses a missing required field and says what it takes', () => {
    const { errors } = check(empty(), [addBug({ summary: 'x' })]);
    expect(errors.map((e) => e.message)).toEqual([
      'props.severity is required for x:bug nodes (Severity: select, one of low, medium, high)',
    ]);
    expect(check(empty(), [addBug({ severity: null })]).errors).toHaveLength(1);
    expect(check(empty(), [addBug({ severity: '' })]).errors).toHaveLength(1);
  });

  it('treats null and "" as cleared: fine for optional fields', () => {
    const cleared = { severity: 'low', summary: null, points: '', found: null, ticket: '' };
    expect(check(empty(), [addBug(cleared)]).errors).toEqual([]);
  });

  it('allows props that are not declared fields', () => {
    expect(check(empty(), [addBug({ severity: 'low', 'tool.trace': { id: 7 } })]).errors).toEqual(
      [],
    );
  });

  it('refuses a status on a type without one', () => {
    const op: Op = {
      op: 'add_node',
      node: { type: 'x:persona', title: 'Ada', status: 'todo', props: { role: 'Admin' } },
    };
    expect(check(empty(), [op]).errors[0]?.message).toContain('x:persona nodes have no status');
    expect(check(empty(), [addBug({ severity: 'low' }, { status: 'todo' })]).errors).toEqual([]);
  });

  it('leaves undeclared custom types and built-in types alone', () => {
    const ops: Op[] = [
      { op: 'add_node', node: { type: 'x:other', title: 'Free', props: { severity: 'urgent' } } },
      { op: 'add_node', node: { type: 'task', title: 'Task', props: { severity: 'urgent' } } },
    ];
    expect(check(empty(), ops).errors).toEqual([]);
  });

  it('checks an update on the fields it changes, with the index of the op', () => {
    const { outcome } = check(empty(), [addBug(valid)]);
    if (!outcome.ok) throw new Error('setup');
    const board = outcome.board;
    const id = outcome.applied.refs.b as string;
    const update = (patch: Record<string, unknown>): Op => ({ op: 'update_node', id, patch }) as Op;
    const bad = check(board, [
      { op: 'add_node', node: { type: 'note', title: 'n' } },
      update({ props: { ...valid, points: 'many' } }),
    ]).errors;
    expect(bad).toEqual([
      expect.objectContaining({ index: 1, message: expect.stringContaining('props.points') }),
    ]);
    // Clearing a required field is refused; clearing all props too.
    expect(check(board, [update({ props: { ...valid, severity: null } })]).errors).toHaveLength(1);
    expect(check(board, [update({ props: null })]).errors).toHaveLength(1);
    expect(check(board, [update({ title: 'Renamed' })]).errors).toEqual([]);
  });

  it('checks a node whose type changes to a declared one whole', () => {
    const board = check(empty(), [
      { op: 'add_node', id: 'n_1', node: { type: 'note', title: 'x' } },
    ]).outcome;
    if (!board.ok) throw new Error('setup');
    const { errors } = check(board.board, [
      { op: 'update_node', id: 'n_1', patch: { type: 'x:bug' } },
    ]);
    expect(errors[0]?.message).toContain('props.severity is required');
  });

  it('follows refs through a batch: an add then an update of the same node', () => {
    const { errors } = check(empty(), [
      addBug({ severity: 'low' }),
      { op: 'update_node', id: '$b', patch: { props: { severity: 'never' } } },
    ]);
    expect(errors).toEqual([expect.objectContaining({ index: 1 })]);
  });
});

describe('nodes made before a definition was tightened', () => {
  // A board with an x:bug that has no severity: valid before `severity` became required.
  function legacy(): Board {
    const loose = registry({ 'x:bug': { label: 'Bug' } });
    const { outcome } = check(
      empty(),
      [
        {
          op: 'add_node',
          id: 'n_old',
          node: { type: 'x:bug', title: 'Old', status: 'todo', props: { points: 'lots' } },
        },
      ],
      loose,
    );
    if (!outcome.ok) throw new Error('setup');
    return outcome.board;
  }
  const strict = registry({ 'x:bug': { ...BUG, hasStatus: false } });

  it('are not refused for what an op leaves alone', () => {
    const board = legacy();
    const ops: Op[] = [
      { op: 'update_node', id: 'n_old', patch: { title: 'Renamed', body: 'More' } },
      {
        op: 'update_node',
        id: 'n_old',
        patch: { props: { points: 'lots', summary: 'Now summarised' } },
      },
      { op: 'move_node', id: 'n_old', view: { x: 10, y: 10 } },
    ];
    expect(check(board, ops, strict).errors).toEqual([]);
  });

  it('are refused for the fields an op touches', () => {
    const board = legacy();
    const errors = check(
      board,
      [
        { op: 'update_node', id: 'n_old', patch: { props: { points: 'still lots' } } },
        { op: 'update_node', id: 'n_old', patch: { status: 'done' } },
      ],
      strict,
    ).errors;
    expect(errors.map((e) => e.index)).toEqual([0, 1]);
  });

  it('are listed by checkBoardAgainstTypes', () => {
    const warnings = checkBoardAgainstTypes(legacy(), strict);
    expect(warnings.map((w) => w.nodeId)).toEqual(['n_old', 'n_old', 'n_old']);
    expect(warnings.map((w) => w.message).join('\n')).toMatch(/severity is required/);
    expect(checkBoardAgainstTypes(legacy(), registry({}))).toEqual([]);
  });
});

describe('mergeTypes', () => {
  it('lets the project win and reports the plugin that lost', () => {
    const { types, conflicts } = mergeTypes({ nodeTypes: { 'x:bug': BUG } }, [
      { name: 'one', nodeTypes: { 'x:bug': PERSONA, 'x:extra': PERSONA } },
      { name: 'two', nodeTypes: { 'x:extra': BUG }, edgeTypes: { 'x:e': { label: 'E' } } },
    ]);
    expect(types.nodeTypes['x:bug']?.source).toBe('project');
    expect(types.nodeTypes['x:extra']).toMatchObject({ source: 'plugin', plugin: 'one' });
    expect(types.edgeTypes['x:e']).toMatchObject({ plugin: 'two' });
    expect(conflicts).toEqual([
      { plugin: 'one', message: expect.stringContaining('.openboard/config.json') },
      { plugin: 'two', message: expect.stringContaining('plugin "one"') },
    ]);
  });
});

describe('renderSchema', () => {
  it('describes built-in and declared types compactly', () => {
    const result = renderSchema(TYPES);
    expect(result.nodeTypes.map((t) => t.type)).toEqual([
      'note',
      'task',
      'decision',
      'question',
      'risk',
      'doc',
      'code',
      'agent',
      'run',
      'frame',
      'x:bug',
      'x:persona',
    ]);
    expect(result.edgeTypes.find((t) => t.type === 'relates_to')?.directed).toBe(false);
    expect(result.statuses.map((s) => s.status)).toEqual([
      'todo',
      'in_progress',
      'blocked',
      'done',
      'cancelled',
    ]);
    expect(result.text).toContain('x:bug "Bug": A defect someone found.');
    expect(result.text).toContain('props.severity "Severity": select low|medium|high, required');
    expect(result.text).toContain('x:persona "Persona", no status');
    expect(result.text).toContain('decision: ');
    expect(result.truncated).toBe(false);
  });

  it('stays under its token ceiling with ten declared types', () => {
    const nodeTypes: Record<string, NodeTypeDef> = {};
    for (let i = 0; i < 10; i++) {
      nodeTypes[`x:type${i}`] = {
        label: `Type ${i}`,
        description: 'Something a project tracks, described in one sentence for people and agents.',
        fields: [
          { key: 'owner', label: 'Owner', kind: 'text', description: 'Who is responsible.' },
          { key: 'level', label: 'Level', kind: 'select', options: ['low', 'medium', 'high'] },
          { key: 'due', label: 'Due', kind: 'date' },
          { key: 'score', label: 'Score', kind: 'number', required: true },
        ],
      };
    }
    const result = renderSchema(registry(nodeTypes));
    expect(result.truncated).toBe(false);
    for (let i = 0; i < 10; i++) expect(result.text).toContain(`x:type${i}`);
    expect(result.tokens).toBeLessThan(1400);
  });

  it('drops declared types from the text, not the data, when the budget is small', () => {
    const nodeTypes: Record<string, NodeTypeDef> = {};
    for (let i = 0; i < 30; i++) nodeTypes[`x:t${i}`] = BUG;
    const result = renderSchema(registry(nodeTypes), { maxTokens: 600 });
    expect(result.truncated).toBe(true);
    expect(result.tokens).toBeLessThanOrEqual(600);
    expect(result.text).toContain('[Truncated:');
    expect(result.nodeTypes).toHaveLength(40);
  });
});

describe('reading declared fields', () => {
  const board = (() => {
    const { outcome } = check(empty(), [
      addBug({ severity: 'high', points: 3, ticket: 'https://example.com/1', trace: 'abc' }),
    ]);
    if (!outcome.ok) throw new Error('setup');
    return outcome.board;
  })();

  it('prints values with their labels at summary and full detail', () => {
    const nodes = Object.values(board.nodes);
    const summary = renderRead(board, nodes, 1, { types: TYPES }).text;
    expect(summary).toContain('fields: Severity "high", Points 3, Ticket "https://example.com/1"');
    const full = renderRead(board, nodes, 1, { types: TYPES, detail: 'full' }).text;
    expect(full).toContain('fields: Severity "high"');
    expect(full).toContain('other props {"trace":"abc"}');
    expect(renderRead(board, nodes, 1, { types: TYPES, detail: 'titles' }).text).not.toContain(
      'fields:',
    );
    // Without declared types the read is what it was.
    const plain = renderRead(board, nodes, 1, { detail: 'full' }).text;
    expect(plain).toMatch(/props \{.*"points":3/);
    expect(plain).not.toContain('fields:');
  });

  it('ends the outline with the declared types', () => {
    expect(renderOutline(board, 1, { types: TYPES }).text.split('\n').at(-1)).toBe(
      'Custom types: x:bug, x:persona - see the schema.',
    );
    expect(renderOutline(board, 1, { types: TYPES, typeProblems: 2 }).text).toContain(
      '2 problems on this board',
    );
    expect(renderOutline(board, 1).text).not.toContain('Custom types');
  });
});
