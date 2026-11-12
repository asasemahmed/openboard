/**
 * The declared types (`GET /api/schema`), read once per page and again when
 * the project settings change or the window regains focus, since a plugin or
 * a teammate may have changed them meanwhile.
 */
import type { SchemaEdgeType, SchemaNodeType, SchemaResult } from '@openboard/core';
import { api } from './boards.js';
import { useValue, Value } from './emitter.js';

export interface TypesIndex {
  nodeTypes: readonly SchemaNodeType[];
  edgeTypes: readonly SchemaEdgeType[];
  node: ReadonlyMap<string, SchemaNodeType>;
  edge: ReadonlyMap<string, SchemaEdgeType>;
  /** Declared (non built-in) types, in the server's order. */
  declaredNodes: readonly SchemaNodeType[];
  declaredEdges: readonly SchemaEdgeType[];
}

export const EMPTY_INDEX: TypesIndex = {
  nodeTypes: [],
  edgeTypes: [],
  node: new Map(),
  edge: new Map(),
  declaredNodes: [],
  declaredEdges: [],
};

export function indexSchema(schema: Pick<SchemaResult, 'nodeTypes' | 'edgeTypes'>): TypesIndex {
  return {
    nodeTypes: schema.nodeTypes,
    edgeTypes: schema.edgeTypes,
    node: new Map(schema.nodeTypes.map((t) => [t.type, t])),
    edge: new Map(schema.edgeTypes.map((t) => [t.type, t])),
    declaredNodes: schema.nodeTypes.filter((t) => t.source !== 'builtin'),
    declaredEdges: schema.edgeTypes.filter((t) => t.source !== 'builtin'),
  };
}

export const types = new Value<TypesIndex>(EMPTY_INDEX);

let inflight: Promise<void> | null = null;
let lastLoad = 0;
const FOCUS_GAP_MS = 5_000;

/** Read the schema now (one request at a time). Failures keep what is known. */
export function refreshSchema(): Promise<void> {
  inflight ??= api
    .schema()
    .then((schema) => {
      lastLoad = Date.now();
      types.set(indexSchema(schema));
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

let watching = false;

/** Load once, then refresh on focus (at most every few seconds). */
export function watchSchema(): void {
  if (watching) return;
  watching = true;
  void refreshSchema();
  window.addEventListener('focus', () => {
    if (Date.now() - lastLoad > FOCUS_GAP_MS) void refreshSchema();
  });
}

export function useTypes(): TypesIndex {
  return useValue(types);
}

export function useNodeTypeDef(type: string): SchemaNodeType | undefined {
  const index = useValue(types);
  const def = index.node.get(type);
  return def && def.source !== 'builtin' ? def : undefined;
}
