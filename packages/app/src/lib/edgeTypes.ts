/**
 * How each relationship looks. Every type differs by more than colour: dash
 * pattern and end marker carry the meaning too.
 */
import { BUILTIN_EDGE_TYPES } from '@openboard/core';

export type EdgeMarker = 'none' | 'arrow' | 'open' | 'tee' | 'hollow' | 'dot';

export interface EdgeMeta {
  type: string;
  /** Short label shown on the edge, e.g. "depends on". */
  label: string;
  dash?: string;
  marker: EdgeMarker;
  /** Suffix of the `--edge-*` colour token. */
  tone: 'muted' | 'ink' | 'danger' | 'accent';
  width: number;
}

const META: Record<string, EdgeMeta> = {
  relates_to: {
    type: 'relates_to',
    label: 'relates to',
    marker: 'none',
    tone: 'muted',
    width: 1.5,
  },
  depends_on: {
    type: 'depends_on',
    label: 'depends on',
    dash: '6 5',
    marker: 'open',
    tone: 'ink',
    width: 1.5,
  },
  blocks: { type: 'blocks', label: 'blocks', marker: 'tee', tone: 'danger', width: 2 },
  implements: {
    type: 'implements',
    label: 'implements',
    marker: 'hollow',
    tone: 'ink',
    width: 1.5,
  },
  evidence_for: {
    type: 'evidence_for',
    label: 'evidence for',
    dash: '1.5 4',
    marker: 'dot',
    tone: 'muted',
    width: 1.75,
  },
  flows_to: { type: 'flows_to', label: 'flows to', marker: 'arrow', tone: 'ink', width: 1.75 },
};

export const EDGE_TYPES: readonly string[] = BUILTIN_EDGE_TYPES;
export const DEFAULT_EDGE_TYPE = 'relates_to';

export function edgeMeta(type: string): EdgeMeta {
  return (
    META[type] ?? {
      type,
      label: type.startsWith('x:') ? type.slice(2).replace(/[-_]/g, ' ') : type,
      marker: 'arrow',
      tone: 'muted',
      width: 1.5,
    }
  );
}
