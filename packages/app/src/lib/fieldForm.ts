/**
 * The inspector form for a declared type's fields: what each input shows,
 * how what a person typed becomes a value (or clears the field), and what is
 * wrong with it. The server does not check edits made in a browser, so this
 * is the guard, using core's own rules.
 */
import {
  checkNodeAgainstType,
  type FieldDef,
  fieldProblem,
  isEmptyValue,
  type Json,
  type NodeTypeDef,
  type TypedShape,
} from '@openboard/core';

/** What the input shows for a stored value. */
export function inputValue(field: FieldDef, value: Json | undefined): string | boolean {
  if (field.kind === 'boolean') return value === true;
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

export interface Parsed {
  /** The value to store; `undefined` clears the field (removes the key). */
  value: Json | undefined;
  /** Why it cannot be stored, or null. A problem blocks saving. */
  problem: string | null;
}

/** Turn what a person entered into a value for `field`. */
export function parseInput(field: FieldDef, raw: string | boolean): Parsed {
  if (field.kind === 'boolean') {
    // An unticked box clears an optional field; a required one stores false.
    if (raw === false && !field.required) return { value: undefined, problem: null };
    return { value: raw === true, problem: null };
  }
  const text = typeof raw === 'string' ? raw : '';
  const trimmed = field.kind === 'longtext' ? text : text.trim();
  if (trimmed === '') {
    return {
      value: undefined,
      problem: field.required ? `${field.label} is required for this type.` : null,
    };
  }
  let value: Json = trimmed;
  if (field.kind === 'number') {
    const n = Number(trimmed.replace(',', '.'));
    if (!Number.isFinite(n))
      return { value: undefined, problem: `${field.label} must be a number.` };
    value = n;
  }
  const problem = fieldProblem(field, value);
  return { value, problem: problem ? `${field.label} ${problem}.` : null };
}

/** `props` with one field set or cleared, keeping every other prop. Null when nothing is left. */
export function propsWith(
  props: Record<string, Json> | undefined,
  key: string,
  value: Json | undefined,
): Record<string, Json> | null {
  const next: Record<string, Json> = { ...(props ?? {}) };
  if (value === undefined || isEmptyValue(value)) delete next[key];
  else next[key] = value;
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * What the node lacks or gets wrong under its declared type, one sentence
 * each for people. Empty when core's `checkNodeAgainstType` finds nothing.
 */
export function typeProblems(node: TypedShape, def: NodeTypeDef): string[] {
  if (checkNodeAgainstType(node, def).length === 0) return [];
  const out: string[] = [];
  for (const field of def.fields ?? []) {
    const value = node.props?.[field.key];
    if (isEmptyValue(value)) {
      if (field.required) out.push(`${field.label} is required.`);
      continue;
    }
    const problem = fieldProblem(field, value);
    if (problem) out.push(`${field.label} ${problem}.`);
  }
  if (def.hasStatus === false && node.status !== undefined)
    out.push('This type has no status, but the node has one.');
  return out;
}

/** Required fields that have no value: what to fill in after switching a node to the type. */
export function missingRequired(node: TypedShape, def: NodeTypeDef): FieldDef[] {
  return (def.fields ?? []).filter((f) => f.required && isEmptyValue(node.props?.[f.key]));
}
