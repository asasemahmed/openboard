import type { SchemaNodeType } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { hasBodyRoom } from '../nodes/CardNode.js';
import { cardModel, fieldText, shortHint } from './declaredTypes.js';
import { typeProblems } from './fieldForm.js';

const ESTIMATE: SchemaNodeType = {
  type: 'x:estimate',
  label: 'Estimate',
  description: 'How big a piece of work is. Agents fill in points and confidence.',
  source: 'plugin',
  plugin: 'estimates',
  color: 'teal',
  icon: 'chart',
  hasStatus: false,
  fields: [
    { key: 'points', label: 'Points', kind: 'number', required: true },
    { key: 'confidence', label: 'Confidence', kind: 'select', options: ['low', 'high'] },
    { key: 'owner', label: 'Owner', kind: 'text' },
  ],
};

const fallback = { label: 'x:estimate', tone: 'custom' };

describe('card model for declared types', () => {
  it('uses the declared label, colour and icon', () => {
    const card = cardModel({ type: 'x:estimate', props: {} }, ESTIMATE, fallback);
    expect(card).toMatchObject({
      label: 'Estimate',
      toneClass: 'tone-c-teal',
      icon: 'chart',
      hasStatus: false,
      declared: true,
    });
  });

  it('shows up to two field values, in field order, skipping empty ones', () => {
    const card = cardModel(
      { type: 'x:estimate', props: { owner: 'Ada', points: 5, confidence: '' } },
      ESTIMATE,
      fallback,
    );
    expect(card.fields).toEqual([
      { key: 'points', label: 'Points', value: '5' },
      { key: 'owner', label: 'Owner', value: 'Ada' },
    ]);
  });

  it('falls back to the generic card for undeclared and built-in types', () => {
    const plain = cardModel({ type: 'x:unknown', props: { a: 1 } }, undefined, fallback);
    expect(plain).toMatchObject({
      label: 'x:estimate',
      toneClass: 'tone-custom',
      icon: null,
      fields: [],
      hasStatus: true,
      declared: false,
    });
    const builtin = cardModel(
      { type: 'task' },
      { ...ESTIMATE, type: 'task', source: 'builtin' },
      { label: 'Task', tone: 'task' },
    );
    expect(builtin.toneClass).toBe('tone-task');
    expect(builtin.declared).toBe(false);
  });

  it('uses the generic tone for a declared type without a colour', () => {
    const { color: _c, ...plain } = ESTIMATE;
    expect(cardModel({ type: 'x:estimate' }, plain, fallback).toneClass).toBe('tone-custom');
  });

  it('writes values briefly', () => {
    const text = { key: 'k', label: 'K', kind: 'text' } as const;
    expect(fieldText({ ...text, kind: 'boolean' }, true)).toBe('yes');
    expect(fieldText({ ...text, kind: 'url' }, 'https://example.com/a')).toBe('example.com/a');
    expect(fieldText(text, 'a\n  b')).toBe('a b');
    expect(fieldText(text, 'x'.repeat(60))).toHaveLength(40);
  });

  it('marks a node that does not match its type, with the reasons', () => {
    expect(typeProblems({ type: 'x:estimate', props: { points: 3 } }, ESTIMATE)).toEqual([]);
    expect(
      typeProblems(
        { type: 'x:estimate', status: 'todo', props: { points: 'many', confidence: 'maybe' } },
        ESTIMATE,
      ),
    ).toEqual([
      'Points must be a number (got "many").',
      'Confidence must be one of low, high (got "maybe").',
      'This type has no status, but the node has one.',
    ]);
    expect(typeProblems({ type: 'x:estimate' }, ESTIMATE)).toEqual(['Points is required.']);
  });

  it('shows fields only where the card has its body area', () => {
    // 40 label row + 24 title + 48 body
    expect(hasBodyRoom(112, 1, false)).toBe(true);
    expect(hasBodyRoom(64, 1, false)).toBe(false);
    // With a meta row the same height has no room left.
    expect(hasBodyRoom(112, 1, true)).toBe(false);
    expect(hasBodyRoom(undefined, 1, false)).toBe(false);
  });

  it('cuts a description down to a menu hint', () => {
    expect(shortHint(ESTIMATE.description)).toBe('How big a piece of work is');
    expect(shortHint(undefined)).toBeUndefined();
    expect(shortHint('word '.repeat(40))?.length).toBeLessThanOrEqual(44);
  });
});
