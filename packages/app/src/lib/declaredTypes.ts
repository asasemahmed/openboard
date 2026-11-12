/**
 * Declared types as the canvas shows them: a card's label, colour, icon and
 * field values for a type the project (or a plugin) declared, and the
 * generic card for everything else. Pure, from the schema the server sends.
 */
import type {
  BoardNode,
  FieldDef,
  Json,
  SchemaNodeType,
  TypeColor,
  TypeIcon,
} from '@openboard/core';
import { isEmptyValue } from '@openboard/core';

/** How many field values a card has room for in its body preview. */
export const CARD_FIELDS = 2;
const VALUE_MAX = 40;

export interface CardModel {
  /** What the mono label row reads. */
  label: string;
  /** The class that sets `--tone`: a declared colour, or the generic custom tone. */
  toneClass: string;
  icon: TypeIcon | null;
  /** Up to `CARD_FIELDS` "Label: value" lines, in the type's field order, skipping empty ones. */
  fields: Array<{ key: string; label: string; value: string }>;
  /** Shown only when the type allows a status. */
  hasStatus: boolean;
  declared: boolean;
}

/** A field value in a few words: `true` is "yes", long text is cut. */
export function fieldText(field: FieldDef, value: Json): string {
  let text: string;
  if (typeof value === 'boolean') text = value ? 'yes' : 'no';
  else if (typeof value === 'number') text = String(value);
  else if (typeof value === 'string') text = value.replace(/\s+/g, ' ').trim();
  else text = JSON.stringify(value);
  if (field.kind === 'url') text = text.replace(/^https?:\/\//, '');
  return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text;
}

/** The card for a node; `def` is its declared type, when the schema has one. */
export function cardModel(
  node: Pick<BoardNode, 'type' | 'props'>,
  def: SchemaNodeType | undefined,
  fallback: { label: string; tone: string },
): CardModel {
  if (!def || def.source === 'builtin') {
    return {
      label: fallback.label,
      toneClass: `tone-${fallback.tone}`,
      icon: null,
      fields: [],
      hasStatus: true,
      declared: false,
    };
  }
  const fields: CardModel['fields'] = [];
  for (const field of def.fields) {
    if (fields.length >= CARD_FIELDS) break;
    const value = node.props?.[field.key];
    if (value === undefined || isEmptyValue(value)) continue;
    fields.push({ key: field.key, label: field.label, value: fieldText(field, value) });
  }
  return {
    label: def.label,
    toneClass: def.color ? `tone-c-${def.color}` : 'tone-custom',
    icon: def.icon ?? null,
    fields,
    hasStatus: def.hasStatus,
    declared: true,
  };
}

export const COLOR_NAMES: Record<TypeColor, string> = {
  gray: 'Gray',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  indigo: 'Indigo',
  purple: 'Purple',
  pink: 'Pink',
};

/** A type's description as a one-line hint: its first sentence, cut to fit a menu. */
export function shortHint(description: string | undefined, max = 44): string | undefined {
  if (!description) return undefined;
  const first = description.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  const line = first.replace(/\s+/g, ' ').replace(/\.$/, '');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
