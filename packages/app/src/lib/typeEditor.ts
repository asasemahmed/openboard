/**
 * The type editor in Settings: a draft a person edits, turned into the
 * definition saved in the project config and back. Validation is core's own
 * schemas, so the form refuses what the server would.
 */
import {
  CustomTypeSchema,
  type EdgeTypeDef,
  EdgeTypeDefSchema,
  type FieldDef,
  type FieldKind,
  type NodeTypeDef,
  NodeTypeDefSchema,
  type ProjectConfig,
  TYPE_LIMITS,
  type TypeColor,
  type TypeIcon,
} from '@openboard/core';

export interface FieldDraft {
  key: string;
  label: string;
  kind: FieldKind;
  /** One option per line, for select fields. */
  options: string;
  required: boolean;
  description: string;
}

export interface TypeDraft {
  /** The part after `x:`. */
  name: string;
  label: string;
  description: string;
  color: TypeColor | null;
  icon: TypeIcon | null;
  hasStatus: boolean;
  fields: FieldDraft[];
}

export const EMPTY_FIELD: FieldDraft = {
  key: '',
  label: '',
  kind: 'text',
  options: '',
  required: false,
  description: '',
};

export function emptyType(): TypeDraft {
  return {
    name: '',
    label: '',
    description: '',
    color: null,
    icon: null,
    hasStatus: true,
    fields: [],
  };
}

export function draftFromDef(type: string, def: NodeTypeDef): TypeDraft {
  return {
    name: type.replace(/^x:/, ''),
    label: def.label,
    description: def.description ?? '',
    color: def.color ?? null,
    icon: def.icon ?? null,
    hasStatus: def.hasStatus !== false,
    fields: (def.fields ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      options: (f.options ?? []).join('\n'),
      required: f.required === true,
      description: f.description ?? '',
    })),
  };
}

/** A key from a label: "Story points" → "storyPoints". */
export function keyFromLabel(label: string): string {
  const words = label
    .normalize('NFKD')
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const key = words
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join('')
    .replace(/^[^a-z]+/, '');
  return key.slice(0, 40);
}

export interface Built<T> {
  type: string;
  def: T | null;
  /** One sentence each, with where it is (e.g. "Field 2, key: ..."). */
  problems: string[];
}

const PART: Record<string, string> = {
  label: 'Label',
  description: 'Description',
  key: 'Key',
  kind: 'Kind',
  options: 'Options',
  fields: 'Fields',
  style: 'Style',
};

interface Issue {
  path: PropertyKey[];
  message: string;
  code?: string;
  minimum?: unknown;
  maximum?: unknown;
}

function sentence(issue: Issue, part: string): string {
  if (issue.code === 'too_small' && issue.minimum === 1)
    return part === 'Options' ? 'Options: give at least one.' : `${part} is required.`;
  if (issue.code === 'too_big' && typeof issue.maximum === 'number')
    return part === 'Options' || part === 'Fields'
      ? `${part}: at most ${issue.maximum}.`
      : `${part} is too long (at most ${issue.maximum} characters).`;
  return `${part}: ${issue.message}.`;
}

function issuesOf(error: { issues: readonly Issue[] }): string[] {
  return error.issues.map((issue) => {
    const [first, index, prop] = issue.path;
    if (first === 'fields' && typeof index === 'number') {
      const part = PART[String(prop ?? '')] ?? 'Field';
      return `Field ${index + 1}: ${sentence(issue, part)}`;
    }
    return sentence(issue, PART[String(first ?? '')] ?? 'Type');
  });
}

/** The definition a draft stands for, or what keeps it from being one. */
export function defFromDraft(draft: TypeDraft): Built<NodeTypeDef> {
  const type = `x:${draft.name.trim()}`;
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push('Name is required.');
  else if (!CustomTypeSchema.safeParse(type).success)
    problems.push(
      'Name: lowercase letters, digits, - or _, starting with a letter, at most 40 characters.',
    );
  const def: NodeTypeDef = { label: draft.label.trim() };
  if (draft.description.trim()) def.description = draft.description.trim();
  if (draft.color) def.color = draft.color;
  if (draft.icon) def.icon = draft.icon;
  if (!draft.hasStatus) def.hasStatus = false;
  if (draft.fields.length > 0)
    def.fields = draft.fields.map((f) => {
      const field: FieldDef = { key: f.key.trim(), label: f.label.trim(), kind: f.kind };
      const options = f.options
        .split('\n')
        .map((o) => o.trim())
        .filter(Boolean);
      // An empty list is left out, so the schema says "a select field needs options".
      if (f.kind === 'select' && options.length > 0) field.options = options;
      if (f.required) field.required = true;
      if (f.description.trim()) field.description = f.description.trim();
      return field;
    });
  const parsed = NodeTypeDefSchema.safeParse(def);
  if (!parsed.success) problems.push(...issuesOf(parsed.error));
  return { type, def: problems.length === 0 ? def : null, problems };
}

export interface EdgeDraft {
  name: string;
  label: string;
  description: string;
  style: 'solid' | 'dashed' | 'thick';
  directed: boolean;
}

export function edgeDraftFromDef(type: string, def: EdgeTypeDef): EdgeDraft {
  return {
    name: type.replace(/^x:/, ''),
    label: def.label,
    description: def.description ?? '',
    style: def.style ?? 'solid',
    directed: def.directed !== false,
  };
}

export function edgeDefFromDraft(draft: EdgeDraft): Built<EdgeTypeDef> {
  const type = `x:${draft.name.trim()}`;
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push('Name is required.');
  else if (!CustomTypeSchema.safeParse(type).success)
    problems.push(
      'Name: lowercase letters, digits, - or _, starting with a letter, at most 40 characters.',
    );
  const def: EdgeTypeDef = { label: draft.label.trim() };
  if (draft.description.trim()) def.description = draft.description.trim();
  if (draft.style !== 'solid') def.style = draft.style;
  if (!draft.directed) def.directed = false;
  const parsed = EdgeTypeDefSchema.safeParse(def);
  if (!parsed.success) problems.push(...issuesOf(parsed.error));
  return { type, def: problems.length === 0 ? def : null, problems };
}

/** The config with a node type added, replaced or renamed (from `previous`). */
export function withNodeType(
  config: ProjectConfig,
  type: string,
  def: NodeTypeDef,
  previous?: string,
): ProjectConfig {
  const nodeTypes = { ...(config.nodeTypes ?? {}) };
  if (previous && previous !== type) delete nodeTypes[previous];
  nodeTypes[type] = def;
  return { ...config, nodeTypes };
}

export function withoutNodeType(config: ProjectConfig, type: string): ProjectConfig {
  const nodeTypes = { ...(config.nodeTypes ?? {}) };
  delete nodeTypes[type];
  const out: ProjectConfig = { ...config, nodeTypes };
  if (Object.keys(nodeTypes).length === 0) delete out.nodeTypes;
  return out;
}

export function withEdgeType(
  config: ProjectConfig,
  type: string,
  def: EdgeTypeDef,
  previous?: string,
): ProjectConfig {
  const edgeTypes = { ...(config.edgeTypes ?? {}) };
  if (previous && previous !== type) delete edgeTypes[previous];
  edgeTypes[type] = def;
  return { ...config, edgeTypes };
}

export function withoutEdgeType(config: ProjectConfig, type: string): ProjectConfig {
  const edgeTypes = { ...(config.edgeTypes ?? {}) };
  delete edgeTypes[type];
  const out: ProjectConfig = { ...config, edgeTypes };
  if (Object.keys(edgeTypes).length === 0) delete out.edgeTypes;
  return out;
}

/** Whether the config has room for one more of these. */
export function roomFor(config: ProjectConfig, what: 'node' | 'edge'): boolean {
  return what === 'node'
    ? Object.keys(config.nodeTypes ?? {}).length < TYPE_LIMITS.nodeTypes
    : Object.keys(config.edgeTypes ?? {}).length < TYPE_LIMITS.edgeTypes;
}

/** Move a field up or down in a draft. */
export function moveField(
  fields: readonly FieldDraft[],
  index: number,
  step: -1 | 1,
): FieldDraft[] {
  const target = index + step;
  if (target < 0 || target >= fields.length) return [...fields];
  const next = [...fields];
  [next[index], next[target]] = [next[target] as FieldDraft, next[index] as FieldDraft];
  return next;
}
