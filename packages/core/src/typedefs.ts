/**
 * Project-defined node and edge types.
 *
 * Any `x:name` type is accepted on a board. A project can also *declare* its
 * types in `.openboard/config.json` (`nodeTypes`, `edgeTypes`), and a server
 * plugin can declare more. A declared node type gets a label, a description
 * written for people and agents alike, a colour and icon from small fixed
 * sets, and fields: typed values kept in the node's `props[key]`.
 *
 * Declared types are checked when a batch is applied through the API
 * (`checkOpsAgainstTypes`), but only on what the batch touches: a node that
 * already existed and does not satisfy a definition tightened later is not
 * refused for it, as long as the batch leaves the failing fields alone. Such
 * nodes are listed by `checkBoardAgainstTypes`. Undeclared `x:` types and
 * built-in types are never checked.
 */
import { z } from 'zod';
import { DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS } from './api.js';
import type { Op, OpError } from './ops.js';
import {
  type Board,
  BUILTIN_EDGE_TYPES,
  BUILTIN_NODE_TYPES,
  type BuiltinEdgeType,
  type BuiltinNodeType,
  CustomTypeSchema,
  type Json,
  STATUSES,
  type Status,
} from './schema.js';
import { estimateTokens } from './text.js';
import { compareStrings, jsonEqual } from './util.js';

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Colours a declared type may use. The canvas maps each name to its own shades. */
export const TYPE_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const;
export const TypeColorSchema = z.enum(TYPE_COLORS);
export type TypeColor = z.infer<typeof TypeColorSchema>;

/** Icons a declared type may use: generic names the canvas maps to its icon set. */
export const TYPE_ICONS = [
  'box',
  'circle',
  'star',
  'flag',
  'bookmark',
  'tag',
  'user',
  'users',
  'bot',
  'bug',
  'bolt',
  'beaker',
  'chart',
  'clock',
  'calendar',
  'check',
  'alert',
  'lightbulb',
  'link',
  'file',
  'code',
  'database',
  'server',
  'target',
] as const;
export const TypeIconSchema = z.enum(TYPE_ICONS);
export type TypeIcon = z.infer<typeof TypeIconSchema>;

/**
 * What a field holds. `text` is one line, `longtext` several; `date` is an ISO
 * date (`2026-11-12`); `url` an http(s) URL; `select` one of `options`.
 */
export const FIELD_KINDS = [
  'text',
  'longtext',
  'number',
  'boolean',
  'select',
  'date',
  'url',
] as const;
export const FieldKindSchema = z.enum(FIELD_KINDS);
export type FieldKind = z.infer<typeof FieldKindSchema>;

export const TYPE_LIMITS = {
  nodeTypes: 50,
  edgeTypes: 30,
  fieldsPerType: 30,
  label: 60,
  description: 500,
  fieldDescription: 300,
  options: 50,
  option: 60,
  /** Longest value of a `text` field. */
  text: 1000,
  /** Longest value of a `longtext` field. */
  longtext: 20_000,
} as const;

/** Field keys are identifiers: the key in `props` that holds the value. */
const FieldKeySchema = z
  .string()
  .regex(
    /^[a-z][A-Za-z0-9_]{0,39}$/,
    'a field key is an identifier: a lowercase letter, then letters, digits or _ (at most 40)',
  );

export const FieldDefSchema = z
  .object({
    key: FieldKeySchema,
    label: z.string().trim().min(1).max(TYPE_LIMITS.label),
    kind: FieldKindSchema,
    /** The choices of a `select` field. */
    options: z
      .array(z.string().trim().min(1).max(TYPE_LIMITS.option))
      .min(1)
      .max(TYPE_LIMITS.options)
      .optional(),
    required: z.boolean().optional(),
    /** What goes in the field, for people filling a form and for agents. */
    description: z.string().max(TYPE_LIMITS.fieldDescription).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.kind === 'select' && !field.options) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'a select field needs options' });
    }
    if (field.kind !== 'select' && field.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'options apply to select fields only',
      });
    }
    if (field.options && new Set(field.options).size !== field.options.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'options must be distinct' });
    }
  });
export type FieldDef = z.infer<typeof FieldDefSchema>;

export const NodeTypeDefSchema = z
  .object({
    label: z.string().trim().min(1).max(TYPE_LIMITS.label),
    /** What the type is for, written for both people and agents. */
    description: z.string().max(TYPE_LIMITS.description).optional(),
    color: TypeColorSchema.optional(),
    icon: TypeIconSchema.optional(),
    /** `false`: nodes of this type never carry a status. Absent or true: they may. */
    hasStatus: z.boolean().optional(),
    /** Values live in the node's `props[key]`, in this order on forms. */
    fields: z.array(FieldDefSchema).max(TYPE_LIMITS.fieldsPerType).optional(),
  })
  .superRefine((def, ctx) => {
    const seen = new Set<string>();
    def.fields?.forEach((field, index) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: `field key "${field.key}" is used twice`,
        });
      }
      seen.add(field.key);
    });
  });
export type NodeTypeDef = z.infer<typeof NodeTypeDefSchema>;

export const EdgeStyleSchema = z.enum(['solid', 'dashed', 'thick']);
export type EdgeStyle = z.infer<typeof EdgeStyleSchema>;

export const EdgeTypeDefSchema = z.object({
  label: z.string().trim().min(1).max(TYPE_LIMITS.label),
  description: z.string().max(TYPE_LIMITS.description).optional(),
  style: EdgeStyleSchema.optional(),
  /** Whether the edge reads one way (source to target). Defaults to true. */
  directed: z.boolean().optional(),
});
export type EdgeTypeDef = z.infer<typeof EdgeTypeDefSchema>;

export const NodeTypesSchema = z
  .record(CustomTypeSchema, NodeTypeDefSchema)
  .refine((types) => Object.keys(types).length <= TYPE_LIMITS.nodeTypes, {
    message: `at most ${TYPE_LIMITS.nodeTypes} node types can be declared`,
  });
export const EdgeTypesSchema = z
  .record(CustomTypeSchema, EdgeTypeDefSchema)
  .refine((types) => Object.keys(types).length <= TYPE_LIMITS.edgeTypes, {
    message: `at most ${TYPE_LIMITS.edgeTypes} edge types can be declared`,
  });

// ── Built-in types ───────────────────────────────────────────────────────────

/**
 * The one table of what built-in types and statuses mean, for agents (the
 * schema) and for people (forms and help). Keep each line short and concrete.
 */
export const BUILTIN_NODE_TYPE_INFO: Readonly<
  Record<BuiltinNodeType, { label: string; description: string }>
> = {
  note: { label: 'Note', description: 'Free text: context, an observation, a summary.' },
  task: { label: 'Task', description: 'A piece of work someone will do; usually has a status.' },
  decision: {
    label: 'Decision',
    description: 'A choice made or to be made; the reasoning goes in the body.',
  },
  question: { label: 'Question', description: 'Something open that needs an answer.' },
  risk: {
    label: 'Risk',
    description: 'Something that could go wrong, with its likelihood or impact.',
  },
  doc: { label: 'Document', description: 'A spec, page or design; point at it with links.' },
  code: {
    label: 'Code',
    description: 'A part of the codebase: module, file or function, with a file or symbol link.',
  },
  agent: { label: 'Agent', description: 'An agent or role working on the board and its duties.' },
  run: { label: 'Run', description: 'One execution (test run, deploy, job) and its outcome.' },
  frame: {
    label: 'Frame',
    description: 'A container grouping nodes into an area; children name it as parent.',
  },
};

export const BUILTIN_EDGE_TYPE_INFO: Readonly<
  Record<BuiltinEdgeType, { label: string; description: string; directed: boolean }>
> = {
  relates_to: {
    label: 'Relates to',
    description: 'A loose connection when no other type fits.',
    directed: false,
  },
  depends_on: {
    label: 'Depends on',
    description: 'The source needs the target first.',
    directed: true,
  },
  blocks: {
    label: 'Blocks',
    description: 'The source holds the target up until it is resolved.',
    directed: true,
  },
  implements: {
    label: 'Implements',
    description: 'The source realises the target (code for a task or decision).',
    directed: true,
  },
  evidence_for: {
    label: 'Evidence for',
    description: 'The source supports or weakens the target.',
    directed: true,
  },
  flows_to: {
    label: 'Flows to',
    description: 'Data, control or work moves from source to target.',
    directed: true,
  },
};

export const STATUS_INFO: Readonly<Record<Status, string>> = {
  todo: 'not started',
  in_progress: 'being worked on',
  blocked: 'waiting on something',
  done: 'finished',
  cancelled: 'dropped, kept for the record',
};

// ── The merged registry ──────────────────────────────────────────────────────

export type TypeSourceKind = 'builtin' | 'project' | 'plugin';

export interface DeclaredNodeType extends NodeTypeDef {
  source: 'project' | 'plugin';
  /** The plugin that declares it, for `source: 'plugin'`. */
  plugin?: string;
}

export interface DeclaredEdgeType extends EdgeTypeDef {
  source: 'project' | 'plugin';
  plugin?: string;
}

/** Every declared type in effect: the project's and the plugins'. */
export interface TypeRegistry {
  nodeTypes: Record<string, DeclaredNodeType>;
  edgeTypes: Record<string, DeclaredEdgeType>;
}

export const EMPTY_TYPES: TypeRegistry = Object.freeze({
  nodeTypes: Object.freeze({}) as Record<string, DeclaredNodeType>,
  edgeTypes: Object.freeze({}) as Record<string, DeclaredEdgeType>,
});

/** Something that declares types: the project config or a plugin. */
export interface TypeSource {
  nodeTypes?: Record<string, NodeTypeDef> | undefined;
  edgeTypes?: Record<string, EdgeTypeDef> | undefined;
}

export interface TypeConflict {
  plugin: string;
  message: string;
}

/**
 * Merge the project's declarations with those of plugins. The project wins on
 * a clash, and so does the earlier plugin between two plugins; every clash is
 * reported once, for the plugin that lost.
 */
export function mergeTypes(
  project: TypeSource | undefined,
  plugins: ReadonlyArray<TypeSource & { name: string }> = [],
): { types: TypeRegistry; conflicts: TypeConflict[] } {
  const nodeTypes: Record<string, DeclaredNodeType> = {};
  const edgeTypes: Record<string, DeclaredEdgeType> = {};
  for (const [type, def] of Object.entries(project?.nodeTypes ?? {})) {
    nodeTypes[type] = { ...def, source: 'project' };
  }
  for (const [type, def] of Object.entries(project?.edgeTypes ?? {})) {
    edgeTypes[type] = { ...def, source: 'project' };
  }
  const conflicts: TypeConflict[] = [];
  const by = (entry: { source: string; plugin?: string }) =>
    entry.source === 'project' ? '.openboard/config.json' : `plugin "${entry.plugin}"`;
  for (const plugin of plugins) {
    for (const [type, def] of Object.entries(plugin.nodeTypes ?? {})) {
      const existing = nodeTypes[type];
      if (existing) {
        conflicts.push({
          plugin: plugin.name,
          message: `node type ${type} is also declared by ${by(existing)}, whose definition is used`,
        });
      } else nodeTypes[type] = { ...def, source: 'plugin', plugin: plugin.name };
    }
    for (const [type, def] of Object.entries(plugin.edgeTypes ?? {})) {
      const existing = edgeTypes[type];
      if (existing) {
        conflicts.push({
          plugin: plugin.name,
          message: `edge type ${type} is also declared by ${by(existing)}, whose definition is used`,
        });
      } else edgeTypes[type] = { ...def, source: 'plugin', plugin: plugin.name };
    }
  }
  return { types: { nodeTypes, edgeTypes }, conflicts };
}

// ── Checking values ──────────────────────────────────────────────────────────

/** Absent, `null` and `""` all mean "no value". Clearing a field sets it to `null` or removes the key. */
export function isEmptyValue(value: Json | undefined): boolean {
  return value === undefined || value === null || value === '';
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isHttpUrl(value: string): boolean {
  if (value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function shown(value: Json): string {
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/** Why `value` does not fit `field`, or null when it does. Empty values always fit (see `required`). */
export function fieldProblem(field: FieldDef, value: Json | undefined): string | null {
  if (value === undefined || isEmptyValue(value)) return null;
  switch (field.kind) {
    case 'text':
    case 'longtext': {
      if (typeof value !== 'string') return `must be a string (got ${shown(value)})`;
      const max = field.kind === 'text' ? TYPE_LIMITS.text : TYPE_LIMITS.longtext;
      if (value.length > max) return `must be at most ${max} characters (got ${value.length})`;
      if (field.kind === 'text' && /[\r\n]/.test(value)) return 'must be one line';
      return null;
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `must be a number (got ${shown(value)})`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `must be true or false (got ${shown(value)})`;
    case 'select':
      return typeof value === 'string' && (field.options ?? []).includes(value)
        ? null
        : `must be one of ${(field.options ?? []).join(', ')} (got ${shown(value)})`;
    case 'date':
      return typeof value === 'string' && isIsoDate(value)
        ? null
        : `must be an ISO date such as 2026-11-12 (got ${shown(value)})`;
    case 'url':
      return typeof value === 'string' && isHttpUrl(value)
        ? null
        : `must be an http or https URL (got ${shown(value)})`;
  }
}

/** The parts of a node that declared types constrain. */
export interface TypedShape {
  type: string;
  status?: Status | undefined;
  props?: Record<string, Json> | undefined;
}

/**
 * What is wrong with `node` under `def`. With `touched`, only those prop keys
 * (and the status, when `statusTouched`) are checked; without it, everything.
 */
export function checkNodeAgainstType(
  node: TypedShape,
  def: NodeTypeDef,
  touched?: { props: ReadonlySet<string>; status: boolean },
): string[] {
  const problems: string[] = [];
  const of = `for ${node.type} nodes`;
  for (const field of def.fields ?? []) {
    if (touched && !touched.props.has(field.key)) continue;
    const value = node.props?.[field.key];
    if (isEmptyValue(value)) {
      if (field.required) {
        const choices = field.options ? `, one of ${field.options.join(', ')}` : '';
        problems.push(
          `props.${field.key} is required ${of} (${field.label}: ${field.kind}${choices})`,
        );
      }
      continue;
    }
    const problem = fieldProblem(field, value);
    if (problem) problems.push(`props.${field.key} ${problem} ${of}`);
  }
  if (def.hasStatus === false && node.status !== undefined && (!touched || touched.status)) {
    problems.push(
      `${node.type} nodes have no status; leave "status" out (the type sets hasStatus: false)`,
    );
  }
  return problems;
}

function shapeOf(node: TypedShape): TypedShape {
  return { type: node.type, status: node.status, props: node.props };
}

/**
 * Check a batch that `applyOps` accepted against the declared node types.
 * `refs` maps the batch's refs to the ids they got (`AppliedOps.refs`).
 *
 * The rule for nodes that already exist: an op is checked only on what it
 * touches. A new node, or a node whose type changes, is checked whole; an
 * `update_node` is checked on the prop keys whose value it changes and on the
 * status when it sets one. A required field the op clears is reported; one
 * that was already missing is not.
 */
export function checkOpsAgainstTypes(
  board: Board,
  ops: readonly Op[],
  refs: Readonly<Record<string, string>>,
  types: TypeRegistry,
): OpError[] {
  if (Object.keys(types.nodeTypes).length === 0) return [];
  const state = new Map<string, TypedShape | null>();
  const current = (id: string): TypedShape | null => {
    if (state.has(id)) return state.get(id) ?? null;
    const node = board.nodes[id];
    return node ? shapeOf(node) : null;
  };
  const resolve = (target: string): string | undefined =>
    target.startsWith('$') ? refs[target.slice(1)] : target;
  const errors: OpError[] = [];
  const report = (index: number, problems: string[]) => {
    for (const message of problems) errors.push({ index, code: 'invalid', message });
  };

  ops.forEach((op, index) => {
    if (op.op === 'add_node') {
      const shape = shapeOf(op.node);
      const def = types.nodeTypes[shape.type];
      if (def) report(index, checkNodeAgainstType(shape, def));
      const id = op.id ?? (op.ref !== undefined ? refs[op.ref] : undefined);
      if (id !== undefined) state.set(id, shape);
    } else if (op.op === 'update_node') {
      const id = resolve(op.id);
      const before = id === undefined ? null : current(id);
      if (id === undefined || !before) return;
      const patch = op.patch;
      const after: TypedShape = { ...before };
      if (patch.type !== undefined) after.type = patch.type;
      if (patch.status !== undefined) after.status = patch.status ?? undefined;
      if (patch.props !== undefined) after.props = patch.props ?? undefined;
      state.set(id, after);
      const def = types.nodeTypes[after.type];
      if (!def) return;
      if (after.type !== before.type) {
        report(index, checkNodeAgainstType(after, def));
        return;
      }
      const keys = new Set([...Object.keys(before.props ?? {}), ...Object.keys(after.props ?? {})]);
      const touched = new Set<string>();
      for (const key of keys) {
        if (!jsonEqual(before.props?.[key], after.props?.[key])) touched.add(key);
      }
      report(
        index,
        checkNodeAgainstType(after, def, {
          props: touched,
          status: patch.status !== undefined && patch.status !== null,
        }),
      );
    } else if (op.op === 'remove_node') {
      state.set(op.id, null);
    }
  });
  return errors;
}

/** A node on the board that does not satisfy its declared type. */
export interface TypeWarning {
  nodeId: string;
  type: string;
  message: string;
}

/** Every node of a declared type that does not satisfy its definition, sorted by node id. */
export function checkBoardAgainstTypes(board: Board, types: TypeRegistry): TypeWarning[] {
  const out: TypeWarning[] = [];
  for (const id of Object.keys(board.nodes).sort(compareStrings)) {
    const node = board.nodes[id];
    const def = node && types.nodeTypes[node.type];
    if (!node || !def) continue;
    for (const message of checkNodeAgainstType(node, def)) {
      out.push({ nodeId: id, type: node.type, message });
    }
  }
  return out;
}

// ── The schema, for agents ───────────────────────────────────────────────────

export const SchemaOptionsSchema = z.object({
  /** Also check this board against the declared types and list what does not fit. */
  board: z.string().max(64).optional(),
  maxTokens: z.number().int().min(100).max(MAX_MAX_TOKENS).optional(),
});
export type SchemaOptions = z.infer<typeof SchemaOptionsSchema>;

export interface SchemaNodeType {
  type: string;
  label: string;
  description?: string;
  source: TypeSourceKind;
  plugin?: string;
  color?: TypeColor;
  icon?: TypeIcon;
  /** Whether nodes of this type may carry a status. */
  hasStatus: boolean;
  fields: FieldDef[];
}

export interface SchemaEdgeType {
  type: string;
  label: string;
  description?: string;
  source: TypeSourceKind;
  plugin?: string;
  style?: EdgeStyle;
  directed: boolean;
}

/** Every type a board can use, built-in and declared. */
export interface SchemaResult {
  nodeTypes: SchemaNodeType[];
  edgeTypes: SchemaEdgeType[];
  statuses: Array<{ status: Status; description: string }>;
  /** With `board`: nodes that do not satisfy their declared type (see `checkBoardAgainstTypes`). */
  warnings?: TypeWarning[];
  text: string;
  tokens: number;
  /** True when `text` had to leave declared types out; the structured lists are always complete. */
  truncated: boolean;
}

/** The structured schema: built-in types first, then declared ones sorted by name. */
export function schemaOf(types: TypeRegistry): Omit<SchemaResult, 'text' | 'tokens' | 'truncated'> {
  const nodeTypes: SchemaNodeType[] = BUILTIN_NODE_TYPES.map((type) => ({
    type,
    ...BUILTIN_NODE_TYPE_INFO[type],
    source: 'builtin',
    hasStatus: true,
    fields: [],
  }));
  for (const type of Object.keys(types.nodeTypes).sort(compareStrings)) {
    const def = types.nodeTypes[type] as DeclaredNodeType;
    const entry: SchemaNodeType = {
      type,
      label: def.label,
      source: def.source,
      hasStatus: def.hasStatus !== false,
      fields: def.fields ?? [],
    };
    if (def.description !== undefined) entry.description = def.description;
    if (def.plugin !== undefined) entry.plugin = def.plugin;
    if (def.color !== undefined) entry.color = def.color;
    if (def.icon !== undefined) entry.icon = def.icon;
    nodeTypes.push(entry);
  }
  const edgeTypes: SchemaEdgeType[] = BUILTIN_EDGE_TYPES.map((type) => ({
    type,
    ...BUILTIN_EDGE_TYPE_INFO[type],
    source: 'builtin',
  }));
  for (const type of Object.keys(types.edgeTypes).sort(compareStrings)) {
    const def = types.edgeTypes[type] as DeclaredEdgeType;
    const entry: SchemaEdgeType = {
      type,
      label: def.label,
      source: def.source,
      directed: def.directed !== false,
    };
    if (def.description !== undefined) entry.description = def.description;
    if (def.plugin !== undefined) entry.plugin = def.plugin;
    if (def.style !== undefined) entry.style = def.style;
    edgeTypes.push(entry);
  }
  const statuses = STATUSES.map((status) => ({ status, description: STATUS_INFO[status] }));
  return { nodeTypes, edgeTypes, statuses };
}

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

function fieldLine(field: FieldDef): string {
  const kind =
    field.kind === 'select' ? `select ${(field.options ?? []).join('|')}` : (field.kind as string);
  const parts = [`  props.${field.key} ${JSON.stringify(field.label)}: ${kind}`];
  if (field.required) parts.push(', required');
  if (field.description) parts.push(` - ${flat(field.description)}`);
  return parts.join('');
}

function declaredNodeLines(entry: SchemaNodeType): string[] {
  const from = entry.source === 'plugin' ? `, from plugin ${entry.plugin}` : '';
  const status = entry.hasStatus ? '' : ', no status';
  const head = `${entry.type} ${JSON.stringify(entry.label)}${from}${status}`;
  const lines = [entry.description ? `${head}: ${flat(entry.description)}` : head];
  for (const field of entry.fields) lines.push(fieldLine(field));
  return lines;
}

function declaredEdgeLine(entry: SchemaEdgeType): string {
  const from = entry.source === 'plugin' ? `, from plugin ${entry.plugin}` : '';
  const how = entry.directed ? '' : ', undirected';
  const head = `${entry.type} ${JSON.stringify(entry.label)}${from}${how}`;
  return entry.description ? `${head}: ${flat(entry.description)}` : head;
}

/** The schema as compact text for a model, within `maxTokens`. */
export function renderSchema(
  types: TypeRegistry,
  opts: { maxTokens?: number; warnings?: TypeWarning[]; boardId?: string } = {},
): SchemaResult {
  const data = schemaOf(types);
  const budget = Math.min(Math.max(1, opts.maxTokens ?? DEFAULT_MAX_TOKENS), MAX_MAX_TOKENS);
  const builtinNodes = data.nodeTypes.filter((t) => t.source === 'builtin');
  const declaredNodes = data.nodeTypes.filter((t) => t.source !== 'builtin');
  const builtinEdges = data.edgeTypes.filter((t) => t.source === 'builtin');
  const declaredEdges = data.edgeTypes.filter((t) => t.source !== 'builtin');

  const render = (nodeCount: number, edgeCount: number): string => {
    const lines = ['Node types (built-in):'];
    for (const t of builtinNodes) lines.push(`${t.type}: ${t.description}`);
    if (declaredNodes.length > 0) {
      lines.push(
        'Declared node types (field values go in props.<key>; other props are allowed; checked on apply):',
      );
      for (const t of declaredNodes.slice(0, nodeCount)) lines.push(...declaredNodeLines(t));
    }
    lines.push('Edge types (built-in):');
    for (const t of builtinEdges) lines.push(`${t.type}: ${t.description}`);
    if (declaredEdges.length > 0) {
      lines.push('Declared edge types:');
      for (const t of declaredEdges.slice(0, edgeCount)) lines.push(declaredEdgeLine(t));
    }
    lines.push(
      `Statuses: ${data.statuses.map((s) => `${s.status} (${s.description})`).join(', ')}.`,
    );
    lines.push('Any other type named x:<name> is accepted without checks.');
    const hidden = declaredNodes.length - nodeCount + (declaredEdges.length - edgeCount);
    if (hidden > 0) {
      const names = [
        ...declaredNodes.slice(nodeCount).map((t) => t.type),
        ...declaredEdges.slice(edgeCount).map((t) => t.type),
      ];
      lines.push(
        `[Truncated: ${hidden} more declared type${hidden === 1 ? '' : 's'} not shown (${names.join(', ')}). To see ${hidden === 1 ? 'it' : 'them'}: raise maxTokens (now ${budget}, at most ${MAX_MAX_TOKENS}).]`,
      );
    }
    if (opts.warnings !== undefined) {
      const w = opts.warnings;
      if (w.length === 0)
        lines.push(`Board ${opts.boardId ?? ''}: every node fits its declared type.`);
      else {
        lines.push(
          `Board ${opts.boardId ?? ''}: ${w.length} problem${w.length === 1 ? '' : 's'} with declared types (made before a type changed, or edited in a browser):`,
        );
        for (const warning of w.slice(0, 10)) lines.push(`  ${warning.nodeId}: ${warning.message}`);
        if (w.length > 10) lines.push(`  and ${w.length - 10} more`);
      }
    }
    return lines.join('\n');
  };

  let nodeCount = declaredNodes.length;
  let edgeCount = declaredEdges.length;
  let text = render(nodeCount, edgeCount);
  while (estimateTokens(text) > budget && nodeCount + edgeCount > 0) {
    if (edgeCount > 0 && edgeCount >= nodeCount) edgeCount--;
    else nodeCount--;
    text = render(nodeCount, edgeCount);
  }
  const result: SchemaResult = {
    ...data,
    text,
    tokens: estimateTokens(text),
    truncated: nodeCount < declaredNodes.length || edgeCount < declaredEdges.length,
  };
  if (opts.warnings !== undefined) result.warnings = opts.warnings;
  return result;
}

/** Declared fields with a value on this node, in field order, for showing next to it. */
export function declaredFieldValues(
  node: TypedShape,
  types: TypeRegistry | undefined,
): Array<{ field: FieldDef; value: Json }> {
  const def = types?.nodeTypes[node.type];
  if (!def?.fields) return [];
  const out: Array<{ field: FieldDef; value: Json }> = [];
  for (const field of def.fields) {
    const value = node.props?.[field.key];
    if (value !== undefined && !isEmptyValue(value)) out.push({ field, value });
  }
  return out;
}
