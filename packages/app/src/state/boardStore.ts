/**
 * The canvas's view of a `BoardDoc`: React Flow nodes and edges, the local
 * selection, and board metadata. It listens to `BoardDoc.observe` and updates
 * only the entries a transaction touched, so unchanged nodes keep their
 * object identity and memoised components skip re-rendering.
 *
 * Transient state that is not written to the document (positions while a
 * drag is in progress, measured sizes, selection flags) also lives here.
 */
import type {
  Actor,
  ApplyOutcome,
  BoardDoc,
  BoardEdge,
  BoardMeta,
  BoardNode,
  DocEvent,
  Op,
} from '@openboard/core';
import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import {
  type FlowEdge,
  type FlowNode,
  orderFlowNodes,
  placementsOf,
  toFlowEdge,
  toFlowNode,
} from '../lib/flow.js';
import type { PlacementMap } from '../lib/geometry.js';
import { Emitter } from './emitter.js';

export interface Selection {
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}

export interface MetaSnapshot {
  meta: BoardMeta;
  actors: Readonly<Record<string, Actor>>;
  ready: boolean;
}

/** Entries that are not on the board yet (for example an agent's proposal). */
export interface GhostLayer {
  nodes: readonly BoardNode[];
  edges: readonly BoardEdge[];
}

const EMPTY_SELECTION: Selection = Object.freeze({ nodeIds: [], edgeIds: [] });

export class BoardStore extends Emitter {
  readonly doc: BoardDoc;

  private readonly nodeMap = new Map<string, FlowNode>();
  private readonly edgeMap = new Map<string, FlowEdge>();
  private readonly ghostNodes = new Map<string, FlowNode>();
  private readonly ghostEdges = new Map<string, FlowEdge>();
  private nodeIndex = new Map<string, number>();
  private edgeIndex = new Map<string, number>();
  private placementCache: PlacementMap | null = null;

  /** Current React Flow nodes, parents before children. Replaced (never mutated) on change. */
  nodes: FlowNode[] = [];
  edges: FlowEdge[] = [];
  selection: Selection = EMPTY_SELECTION;
  meta: MetaSnapshot;

  private readonly selectionListeners = new Set<(selection: Selection) => void>();
  private readonly detach: () => void;

  constructor(doc: BoardDoc) {
    super();
    this.doc = doc;
    this.meta = this.readMeta();
    for (const node of doc.nodes()) this.nodeMap.set(node.id, toFlowNode(node));
    for (const edge of doc.edges()) this.edgeMap.set(edge.id, toFlowEdge(edge));
    this.rebuildNodes();
    this.rebuildEdges();
    this.detach = doc.observe((event) => this.onDocEvent(event));
  }

  destroy(): void {
    this.detach();
    this.selectionListeners.clear();
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  readonly getNodes = (): FlowNode[] => this.nodes;
  readonly getEdges = (): FlowEdge[] => this.edges;
  readonly getSelection = (): Selection => this.selection;
  readonly getMeta = (): MetaSnapshot => this.meta;

  node(id: string): BoardNode | undefined {
    return this.nodeMap.get(id)?.data.node;
  }

  edge(id: string): BoardEdge | undefined {
    return this.edgeMap.get(id)?.data?.edge;
  }

  flowNode(id: string): FlowNode | undefined {
    return this.nodeMap.get(id);
  }

  boardNodes(): Map<string, BoardNode> {
    const out = new Map<string, BoardNode>();
    for (const [id, flow] of this.nodeMap) out.set(id, flow.data.node);
    return out;
  }

  boardEdges(): Map<string, BoardEdge> {
    const out = new Map<string, BoardEdge>();
    for (const [id, flow] of this.edgeMap) if (flow.data) out.set(id, flow.data.edge);
    return out;
  }

  get nodeCount(): number {
    return this.nodeMap.size;
  }

  /** Where every real node is drawn right now, including positions mid-drag. */
  placements(): PlacementMap {
    if (!this.placementCache) this.placementCache = placementsOf(this.nodeMap.values());
    return this.placementCache;
  }

  // ── Writing ────────────────────────────────────────────────────────────────

  /** Apply a batch as `actor` from the UI. Returns the outcome; failures leave the board untouched. */
  apply(ops: readonly Op[], actor: Actor): ApplyOutcome {
    if (ops.length === 0) return { ok: false, errors: [] };
    const outcome = this.doc.apply(ops, { actor, source: 'ui' });
    if (!outcome.ok) this.resetTransient();
    return outcome;
  }

  // ── Document events ────────────────────────────────────────────────────────

  private onDocEvent(event: DocEvent): void {
    let structuralNodes = false;
    let structuralEdges = false;
    const changedNodes = new Set<string>();
    const changedEdges = new Set<string>();

    const refreshNode = (id: string) => {
      const prev = this.nodeMap.get(id);
      const node = this.doc.getNode(id);
      if (!node) {
        if (prev) {
          this.nodeMap.delete(id);
          structuralNodes = true;
          // Children of a vanished frame and edges touching the node must be re-read.
          for (const other of this.nodeMap.values())
            if (other.parentId === id) changedNodes.add(other.id);
          for (const edge of this.edgeMap.values())
            if (edge.source === id || edge.target === id) changedEdges.add(edge.id);
        }
        return;
      }
      const next = this.derive(node, prev);
      if (!prev || prev.parentId !== next.parentId || prev.type !== next.type)
        structuralNodes = true;
      if (prev && prev.type === 'frame' && next.type !== 'frame') {
        for (const other of this.nodeMap.values())
          if (other.parentId === id) changedNodes.add(other.id);
      }
      this.nodeMap.set(id, next);
    };

    for (const change of event.changes) {
      if (change.kind.startsWith('node_')) changedNodes.add(change.id);
      else changedEdges.add(change.id);
    }
    // Refreshing can discover more nodes to refresh (children of removed frames).
    const doneNodes = new Set<string>();
    while (doneNodes.size < changedNodes.size) {
      for (const id of changedNodes) {
        if (doneNodes.has(id)) continue;
        doneNodes.add(id);
        refreshNode(id);
      }
    }
    for (const id of changedEdges) {
      const prev = this.edgeMap.get(id);
      const edge = this.doc.getEdge(id);
      if (!edge) {
        if (prev) {
          this.edgeMap.delete(id);
          structuralEdges = true;
        }
        continue;
      }
      if (!prev) structuralEdges = true;
      this.edgeMap.set(id, toFlowEdge(edge, { selected: prev?.selected ?? false }));
    }

    if (doneNodes.size > 0) {
      if (structuralNodes) this.rebuildNodes();
      else this.patchNodes(doneNodes);
    }
    if (changedEdges.size > 0) {
      if (structuralEdges) this.rebuildEdges();
      else this.patchEdges(changedEdges);
    }
    if (event.metaChanged) this.meta = this.readMeta();
    if (doneNodes.size > 0 || changedEdges.size > 0) this.pruneSelection();
    this.emit();
  }

  private derive(node: BoardNode, prev: FlowNode | undefined): FlowNode {
    const next = toFlowNode(node, { selected: prev?.selected ?? false });
    if (prev?.dragging) {
      // Someone else moved this node while it is being dragged here; the drop wins.
      next.position = prev.position;
      next.dragging = true;
    }
    if (prev?.measured) next.measured = prev.measured;
    return next;
  }

  private readMeta(): MetaSnapshot {
    return { meta: this.doc.meta, actors: this.doc.toJSON().actors, ready: this.doc.ready };
  }

  // ── Array maintenance ──────────────────────────────────────────────────────

  private rebuildNodes(): void {
    const nodes = orderFlowNodes([...this.nodeMap.values(), ...this.ghostNodes.values()]);
    this.nodes = nodes;
    this.nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
    this.placementCache = null;
  }

  private rebuildEdges(): void {
    this.edges = [...this.edgeMap.values(), ...this.ghostEdges.values()];
    this.edgeIndex = new Map(this.edges.map((e, i) => [e.id, i]));
  }

  private patchNodes(ids: Iterable<string>): void {
    const nodes = [...this.nodes];
    for (const id of ids) {
      const index = this.nodeIndex.get(id);
      const flow = this.nodeMap.get(id);
      if (index === undefined || !flow) {
        this.rebuildNodes();
        return;
      }
      nodes[index] = flow;
    }
    this.nodes = nodes;
    this.placementCache = null;
  }

  private patchEdges(ids: Iterable<string>): void {
    const edges = [...this.edges];
    for (const id of ids) {
      const index = this.edgeIndex.get(id);
      const flow = this.edgeMap.get(id);
      if (index === undefined || !flow) {
        this.rebuildEdges();
        return;
      }
      edges[index] = flow;
    }
    this.edges = edges;
  }

  // ── React Flow changes (drag, measure, select) ─────────────────────────────

  readonly onNodesChange = (changes: NodeChange<FlowNode>[]): void => {
    const relevant = changes.filter(
      (c) => c.type !== 'remove' && c.type !== 'add' && c.type !== 'replace',
    );
    if (relevant.length === 0) return;
    const before = this.nodes;
    const next = applyNodeChanges(relevant, before);
    let selectionChanged = false;
    for (let i = 0; i < next.length; i++) {
      const n = next[i] as FlowNode;
      if (n === before[i]) continue;
      if ((before[i]?.selected ?? false) !== (n.selected ?? false)) selectionChanged = true;
      if (this.nodeMap.has(n.id)) this.nodeMap.set(n.id, n);
      else if (this.ghostNodes.has(n.id)) this.ghostNodes.set(n.id, n);
    }
    this.nodes = next;
    this.placementCache = null;
    if (selectionChanged) this.syncSelectionFromFlags();
    this.emit();
  };

  readonly onEdgesChange = (changes: EdgeChange<FlowEdge>[]): void => {
    const relevant = changes.filter((c) => c.type === 'select');
    if (relevant.length === 0) return;
    const before = this.edges;
    const next = applyEdgeChanges(relevant, before);
    for (let i = 0; i < next.length; i++) {
      const e = next[i] as FlowEdge;
      if (e !== before[i] && this.edgeMap.has(e.id)) this.edgeMap.set(e.id, e);
    }
    this.edges = next;
    this.syncSelectionFromFlags();
    this.emit();
  };

  /** Throw away drag positions and sizes that were not committed, and re-read from the document. */
  resetTransient(ids?: Iterable<string>): void {
    const targets = ids ? [...ids] : [...this.nodeMap.keys()];
    for (const id of targets) {
      const prev = this.nodeMap.get(id);
      const node = this.doc.getNode(id);
      if (!prev || !node) continue;
      const next = toFlowNode(node, { selected: prev.selected ?? false });
      if (prev.measured) next.measured = prev.measured;
      this.nodeMap.set(id, next);
    }
    this.rebuildNodes();
    this.emit();
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  /** Called with the new selection whenever it changes, however it changed. */
  onSelectionChange(listener: (selection: Selection) => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  select(nodeIds: Iterable<string>, edgeIds: Iterable<string> = []): void {
    const nodes = new Set([...nodeIds].filter((id) => this.nodeMap.has(id)));
    const edges = new Set([...edgeIds].filter((id) => this.edgeMap.has(id)));
    let nodesChanged = false;
    for (const [id, flow] of this.nodeMap) {
      const want = nodes.has(id);
      if ((flow.selected ?? false) !== want) {
        this.nodeMap.set(id, { ...flow, selected: want });
        nodesChanged = true;
      }
    }
    let edgesChanged = false;
    for (const [id, flow] of this.edgeMap) {
      const want = edges.has(id);
      if ((flow.selected ?? false) !== want) {
        this.edgeMap.set(id, { ...flow, selected: want });
        edgesChanged = true;
      }
    }
    if (nodesChanged) this.rebuildNodes();
    if (edgesChanged) this.rebuildEdges();
    this.setSelection([...nodes], [...edges]);
    this.emit();
  }

  clearSelection(): void {
    this.select([], []);
  }

  selectAll(): void {
    this.select(this.nodeMap.keys(), []);
  }

  private syncSelectionFromFlags(): void {
    const nodeIds: string[] = [];
    const edgeIds: string[] = [];
    for (const n of this.nodeMap.values()) if (n.selected) nodeIds.push(n.id);
    for (const e of this.edgeMap.values()) if (e.selected) edgeIds.push(e.id);
    this.setSelection(nodeIds, edgeIds);
  }

  /** Drop ids that no longer exist (removed locally or by someone else). */
  private pruneSelection(): void {
    const nodeIds = this.selection.nodeIds.filter((id) => this.nodeMap.has(id));
    const edgeIds = this.selection.edgeIds.filter((id) => this.edgeMap.has(id));
    this.setSelection(nodeIds, edgeIds);
  }

  private setSelection(nodeIds: readonly string[], edgeIds: readonly string[]): void {
    const sortedNodes = [...nodeIds].sort();
    const sortedEdges = [...edgeIds].sort();
    const same =
      sortedNodes.length === this.selection.nodeIds.length &&
      sortedEdges.length === this.selection.edgeIds.length &&
      sortedNodes.every((id, i) => id === this.selection.nodeIds[i]) &&
      sortedEdges.every((id, i) => id === this.selection.edgeIds[i]);
    if (same) return;
    this.selection =
      sortedNodes.length === 0 && sortedEdges.length === 0
        ? EMPTY_SELECTION
        : Object.freeze({ nodeIds: sortedNodes, edgeIds: sortedEdges });
    for (const listener of [...this.selectionListeners]) listener(this.selection);
  }

  // ── Ghost layer ────────────────────────────────────────────────────────────

  /**
   * Show entries that are not on the board yet, drawn dashed in the accent
   * colour. Replaces any previous ghost layer; pass an empty layer to clear.
   * Ghost ids must not collide with real ones.
   */
  setGhosts(layer: GhostLayer): void {
    this.ghostNodes.clear();
    this.ghostEdges.clear();
    for (const node of layer.nodes) {
      if (this.nodeMap.has(node.id)) continue;
      this.ghostNodes.set(node.id, toFlowNode(node, { ghost: true }));
    }
    const known = (id: string) => this.nodeMap.has(id) || this.ghostNodes.has(id);
    for (const edge of layer.edges) {
      if (this.edgeMap.has(edge.id) || !known(edge.source) || !known(edge.target)) continue;
      this.ghostEdges.set(edge.id, toFlowEdge(edge, { ghost: true }));
    }
    this.rebuildNodes();
    this.rebuildEdges();
    this.emit();
  }
}
