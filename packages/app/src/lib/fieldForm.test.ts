import type { FieldDef } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { inputValue, missingRequired, parseInput, propsWith } from './fieldForm.js';

const f = (kind: FieldDef['kind'], extra: Partial<FieldDef> = {}): FieldDef => ({
  key: 'v',
  label: 'Value',
  kind,
  ...extra,
});

describe('generated field form', () => {
  it('text: trims, refuses line breaks, clears when empty', () => {
    expect(parseInput(f('text'), '  hi  ')).toEqual({ value: 'hi', problem: null });
    expect(parseInput(f('text'), '')).toEqual({ value: undefined, problem: null });
    expect(parseInput(f('text', { required: true }), ' ')).toEqual({
      value: undefined,
      problem: 'Value is required for this type.',
    });
    expect(parseInput(f('text'), 'x'.repeat(1001)).problem).toMatch(/at most 1000/);
  });

  it('longtext keeps line breaks and its own length limit', () => {
    expect(parseInput(f('longtext'), 'a\nb').value).toBe('a\nb');
    expect(parseInput(f('longtext'), 'x'.repeat(20_001)).problem).toMatch(/at most 20000/);
  });

  it('number: parses, accepts a decimal comma, refuses words', () => {
    expect(parseInput(f('number'), '3')).toEqual({ value: 3, problem: null });
    expect(parseInput(f('number'), '2,5').value).toBe(2.5);
    expect(parseInput(f('number'), 'lots')).toEqual({
      value: undefined,
      problem: 'Value must be a number.',
    });
  });

  it('boolean: an unticked optional box clears; a required one stores false', () => {
    expect(parseInput(f('boolean'), true)).toEqual({ value: true, problem: null });
    expect(parseInput(f('boolean'), false)).toEqual({ value: undefined, problem: null });
    expect(parseInput(f('boolean', { required: true }), false).value).toBe(false);
    expect(inputValue(f('boolean'), true)).toBe(true);
    expect(inputValue(f('boolean'), undefined)).toBe(false);
  });

  it('select: only its options', () => {
    const field = f('select', { options: ['low', 'high'] });
    expect(parseInput(field, 'low').value).toBe('low');
    expect(parseInput(field, 'medium').problem).toMatch(/must be one of low, high/);
  });

  it('date: ISO days that exist', () => {
    expect(parseInput(f('date'), '2026-11-12').problem).toBeNull();
    expect(parseInput(f('date'), '2026-02-30').problem).toMatch(/ISO date/);
    expect(parseInput(f('date'), '12/11/2026').problem).toMatch(/ISO date/);
  });

  it('url: http and https only', () => {
    expect(parseInput(f('url'), 'https://example.com').problem).toBeNull();
    expect(parseInput(f('url'), 'javascript:alert(1)').problem).toMatch(/http or https/);
    expect(parseInput(f('url'), 'example.com').problem).toMatch(/http or https/);
  });

  it('shows stored values as text', () => {
    expect(inputValue(f('number'), 4)).toBe('4');
    expect(inputValue(f('text'), null)).toBe('');
  });

  it('writes one prop, keeps the others, and removes the key when cleared', () => {
    const props = { points: 3, other: 'kept' };
    expect(propsWith(props, 'owner', 'Ada')).toEqual({ points: 3, other: 'kept', owner: 'Ada' });
    expect(propsWith(props, 'points', undefined)).toEqual({ other: 'kept' });
    expect(propsWith(props, 'points', '')).toEqual({ other: 'kept' });
    expect(propsWith({ points: 3 }, 'points', undefined)).toBeNull();
    expect(propsWith(undefined, 'a', 1)).toEqual({ a: 1 });
  });

  it('lists required fields that have no value', () => {
    const def = {
      label: 'Estimate',
      fields: [f('number', { key: 'points', required: true }), f('text', { key: 'note' })],
    };
    expect(missingRequired({ type: 'x:e', props: {} }, def).map((x) => x.key)).toEqual(['points']);
    expect(missingRequired({ type: 'x:e', props: { points: 0 } }, def)).toEqual([]);
  });
});
