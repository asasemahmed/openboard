import { NodeTypesSchema, type ProjectConfig, TYPE_LIMITS } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import {
  defFromDraft,
  draftFromDef,
  EMPTY_FIELD,
  edgeDefFromDraft,
  edgeDraftFromDef,
  emptyType,
  keyFromLabel,
  moveField,
  roomFor,
  type TypeDraft,
  withEdgeType,
  withNodeType,
  withoutEdgeType,
  withoutNodeType,
} from './typeEditor.js';

const EMPTY: ProjectConfig = { version: 1, policy: { default: 'auto', agents: {} } };

const persona: TypeDraft = {
  name: 'persona',
  label: 'Persona',
  description: 'Someone we design for.',
  color: 'purple',
  icon: 'user',
  hasStatus: false,
  fields: [
    { ...EMPTY_FIELD, key: 'role', label: 'Role', required: true },
    { ...EMPTY_FIELD, key: 'size', label: 'Size', kind: 'select', options: 'small\n large \n' },
  ],
};

describe('type editor', () => {
  it('turns a draft into the config definition and back', () => {
    const built = defFromDraft(persona);
    expect(built.problems).toEqual([]);
    expect(built.type).toBe('x:persona');
    expect(built.def).toEqual({
      label: 'Persona',
      description: 'Someone we design for.',
      color: 'purple',
      icon: 'user',
      hasStatus: false,
      fields: [
        { key: 'role', label: 'Role', kind: 'text', required: true },
        { key: 'size', label: 'Size', kind: 'select', options: ['small', 'large'] },
      ],
    });
    const config = withNodeType(EMPTY, built.type, built.def!);
    // What is saved is what the server accepts.
    expect(NodeTypesSchema.safeParse(config.nodeTypes).success).toBe(true);
    const json = JSON.parse(JSON.stringify(config)) as ProjectConfig;
    const back = draftFromDef('x:persona', json.nodeTypes!['x:persona']!);
    expect(back).toEqual({
      ...persona,
      fields: [persona.fields[0], { ...persona.fields[1], options: 'small\nlarge' }],
    });
  });

  it('leaves out what is empty or default', () => {
    const built = defFromDraft({ ...emptyType(), name: 'idea', label: 'Idea' });
    expect(built.def).toEqual({ label: 'Idea' });
  });

  it('refuses what the server would, in sentences', () => {
    expect(defFromDraft({ ...emptyType(), label: 'X' }).problems).toContain('Name is required.');
    expect(defFromDraft({ ...emptyType(), name: 'Bad Name', label: 'X' }).problems[0]).toMatch(
      /^Name: lowercase/,
    );
    expect(defFromDraft({ ...emptyType(), name: 'a' }).problems).toContain('Label is required.');
    expect(
      defFromDraft({ ...emptyType(), name: 'a', label: 'x'.repeat(TYPE_LIMITS.label + 1) })
        .problems,
    ).toContain(`Label is too long (at most ${TYPE_LIMITS.label} characters).`);
    const fields = defFromDraft({
      ...persona,
      fields: [
        { ...EMPTY_FIELD, key: '1st', label: 'First' },
        { ...EMPTY_FIELD, key: 'pick', label: 'Pick', kind: 'select', options: '' },
        { ...EMPTY_FIELD, key: 'pick', label: 'Again' },
      ],
    });
    expect(fields.def).toBeNull();
    expect(fields.problems.join('\n')).toMatch(/Field 1: Key/);
    expect(fields.problems.join('\n')).toMatch(/Field 2: Options: a select field needs options/);
    expect(fields.problems.join('\n')).toMatch(/Field 3: Key: field key "pick" is used twice/);
    const tooMany = defFromDraft({
      ...persona,
      fields: Array.from({ length: TYPE_LIMITS.fieldsPerType + 1 }, (_, i) => ({
        ...EMPTY_FIELD,
        key: `f${i}`,
        label: `F${i}`,
      })),
    });
    expect(tooMany.problems).toContain(`Fields: at most ${TYPE_LIMITS.fieldsPerType}.`);
  });

  it('adds, replaces and removes types without touching the rest of the config', () => {
    const base: ProjectConfig = {
      version: 1,
      policy: { default: 'auto', agents: {} },
      nodeTypes: { 'x:a': { label: 'A' } },
    };
    const added = withNodeType(base, 'x:b', { label: 'B' });
    expect(added).toEqual({
      version: 1,
      policy: { default: 'auto', agents: {} },
      nodeTypes: { 'x:a': { label: 'A' }, 'x:b': { label: 'B' } },
    });
    expect(withNodeType(added, 'x:c', { label: 'C' }, 'x:b').nodeTypes).toEqual({
      'x:a': { label: 'A' },
      'x:c': { label: 'C' },
    });
    expect(withoutNodeType(base, 'x:a')).toEqual({
      version: 1,
      policy: { default: 'auto', agents: {} },
    });
    const edges = withEdgeType(base, 'x:supersedes', { label: 'Supersedes', style: 'dashed' });
    expect(edges.edgeTypes).toEqual({ 'x:supersedes': { label: 'Supersedes', style: 'dashed' } });
    expect(withoutEdgeType(edges, 'x:supersedes').edgeTypes).toBeUndefined();
  });

  it('knows when the project is full', () => {
    const full: ProjectConfig = {
      ...EMPTY,
      nodeTypes: Object.fromEntries(
        Array.from({ length: TYPE_LIMITS.nodeTypes }, (_, i) => [`x:t${i}`, { label: `T${i}` }]),
      ),
    };
    expect(roomFor(full, 'node')).toBe(false);
    expect(roomFor(full, 'edge')).toBe(true);
  });

  it('edge drafts round-trip', () => {
    const built = edgeDefFromDraft({
      name: 'mirrors',
      label: 'Mirrors',
      description: '',
      style: 'thick',
      directed: false,
    });
    expect(built.def).toEqual({ label: 'Mirrors', style: 'thick', directed: false });
    expect(edgeDraftFromDef(built.type, built.def!)).toEqual({
      name: 'mirrors',
      label: 'Mirrors',
      description: '',
      style: 'thick',
      directed: false,
    });
  });

  it('reorders fields and derives keys from labels', () => {
    const [a, b] = persona.fields;
    expect(moveField(persona.fields, 0, 1)).toEqual([b, a]);
    expect(moveField(persona.fields, 0, -1)).toEqual([a, b]);
    expect(keyFromLabel('Story points')).toBe('storyPoints');
    expect(keyFromLabel('2nd owner')).toBe('ndOwner');
  });
});
