/**
 * A tiny helper for writing templates as readable code: each call appends one
 * operation, nodes are named by ref, and parents and edges use those refs.
 */
import type { Op } from '../ops.js';
import type { EdgeType, NodeType, Status } from '../schema.js';

export interface NodeSpec {
  body?: string;
  status?: Status;
  tags?: string[];
  /** Ref of the frame the node sits in. */
  in?: string;
  props?: Record<string, string | number | boolean>;
}

export class TemplateBuilder {
  readonly ops: Op[] = [];

  node(ref: string, type: NodeType, title: string, spec: NodeSpec = {}): this {
    const node: Extract<Op, { op: 'add_node' }>['node'] = { type, title };
    if (spec.body !== undefined) node.body = spec.body;
    if (spec.status !== undefined) node.status = spec.status;
    if (spec.tags !== undefined) node.tags = spec.tags;
    if (spec.props !== undefined) node.props = spec.props;
    if (spec.in !== undefined) node.parent = `$${spec.in}`;
    this.ops.push({ op: 'add_node', ref, node });
    return this;
  }

  frame(ref: string, title: string, spec: Omit<NodeSpec, 'status'> = {}): this {
    return this.node(ref, 'frame', title, spec);
  }

  edge(type: EdgeType, source: string, target: string, label?: string): this {
    const edge: Extract<Op, { op: 'add_edge' }>['edge'] = {
      type,
      source: `$${source}`,
      target: `$${target}`,
    };
    if (label !== undefined) edge.label = label;
    this.ops.push({ op: 'add_edge', edge });
    return this;
  }
}
