/**
 * The board file format: `.openboard/<id>.board.json`.
 *
 * Output is deterministic so that the file works well in git: known fields
 * appear in a fixed order, nodes, edges and actors are sorted by id, free-form
 * objects are sorted by key, empty optional fields are left out, and the file
 * ends with a newline. Each scalar field sits on its own line, so changing one
 * field changes one line.
 */
import { OpenBoardError } from './api.js';
import { type ProjectConfig, ProjectConfigSchema } from './collab.js';
import {
  type Actor,
  type Board,
  type BoardEdge,
  type BoardNode,
  BoardSchema,
  type Comment,
  IdSchema,
  type Json,
  type Link,
  SCHEMA_VERSION,
  type View,
} from './schema.js';
import { compareStrings, formatIssues, formatPath, normalizeEdge, normalizeNode } from './util.js';

// ── Writing ──────────────────────────────────────────────────────────────────

/** An object whose keys are emitted in exactly the given order. */
class Ordered {
  constructor(readonly entries: Array<[string, Value]>) {}
}
type Value = Json | Ordered | undefined;

const BOARD_KEYS = [
  'schemaVersion',
  'id',
  'name',
  'description',
  'createdAt',
  'updatedAt',
] as const;
const ACTOR_KEYS = ['id', 'kind', 'name', 'color'] as const;
const NODE_KEYS = ['id', 'type', 'title', 'status', 'parent', 'tags', 'body'] as const;
const BOOKKEEPING_KEYS = ['createdBy', 'createdAt', 'updatedBy', 'updatedAt'] as const;
const EDGE_KEYS = ['id', 'type', 'source', 'target', 'label'] as const;
const LINK_KEYS = ['kind', 'target', 'line', 'endLine', 'hash', 'stale'] as const;
const VIEW_KEYS = ['x', 'y', 'w', 'h', 'pinned', 'collapsed', 'color'] as const;
const COMMENT_KEYS = [
  'id',
  'thread',
  'nodeId',
  'author',
  'createdAt',
  'mentions',
  'resolvedAt',
  'resolvedBy',
  'body',
] as const;

function pick<T extends object>(
  value: T,
  keys: readonly (keyof T & string)[],
): Array<[string, Value]> {
  return keys.map((key) => [key, value[key] as Value]);
}

function sortedRecord<T>(record: Record<string, T>, each: (value: T) => Value): Ordered {
  const keys = Object.keys(record).sort(compareStrings);
  return new Ordered(keys.map((key) => [key, each(record[key] as T)]));
}

function actorValue(actor: Actor): Ordered {
  return new Ordered(pick(actor, ACTOR_KEYS));
}

function viewValue(view: View): Ordered {
  return new Ordered(pick(view, VIEW_KEYS));
}

function linkValue(link: Link): Ordered {
  return new Ordered(pick(link, LINK_KEYS));
}

function nodeValue(input: BoardNode): Ordered {
  const node = normalizeNode(input);
  return new Ordered([
    ...pick(node, NODE_KEYS),
    ['links', node.links?.map(linkValue) as Value],
    ['props', node.props],
    ['view', node.view && viewValue(node.view)],
    ...pick(node, BOOKKEEPING_KEYS),
  ]);
}

function commentValue(comment: Comment): Ordered {
  return new Ordered(pick(comment, COMMENT_KEYS));
}

function edgeValue(input: BoardEdge): Ordered {
  const edge = normalizeEdge(input);
  return new Ordered([...pick(edge, EDGE_KEYS), ...pick(edge, BOOKKEEPING_KEYS)]);
}

/** Pretty-print with two-space indentation, like `JSON.stringify(value, null, 2)`. */
function emit(value: Value, indent: string): string {
  if (value instanceof Ordered) {
    const entries = value.entries.filter(([, v]) => !isEmpty(v));
    if (entries.length === 0) return '{}';
    const inner = `${indent}  `;
    const lines = entries.map(([key, v]) => `${inner}${JSON.stringify(key)}: ${emit(v, inner)}`);
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = `${indent}  `;
    return `[\n${value.map((v) => inner + emit(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (typeof value === 'object' && value !== null) {
    // Free-form JSON (props): sort keys at every depth, but keep empty values.
    const keys = Object.keys(value).sort(compareStrings);
    if (keys.length === 0) return '{}';
    const inner = `${indent}  `;
    const lines = keys.map((key) => `${inner}${JSON.stringify(key)}: ${emit(value[key], inner)}`);
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Optional fields that carry nothing are left out of the file. Collections
 * (`actors`, `nodes`, `edges`) are `Ordered` and so are always written.
 */
function isEmpty(value: Value): boolean {
  if (value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Ordered) return false;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length === 0;
  return false;
}

/** The board as file text. The same board always produces byte-identical output. */
export function serializeBoard(board: Board): string {
  const root = new Ordered([
    ...pick(board, BOARD_KEYS),
    ['actors', sortedRecord(board.actors, actorValue)],
    ['nodes', sortedRecord(board.nodes, nodeValue)],
    ['edges', sortedRecord(board.edges, edgeValue)],
  ]);
  // Comments are written only when there are some, so boards without any keep their old shape.
  if (board.comments && Object.keys(board.comments).length > 0) {
    root.entries.push(['comments', sortedRecord(board.comments, commentValue)]);
  }
  return `${emit(root, '')}\n`;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** A semantic problem in a board, with the path where it sits. */
export interface BoardProblem {
  path: string;
  message: string;
}

/**
 * Check the rules that the schema alone cannot express (see "Semantic rules"
 * in docs/ARCHITECTURE.md). Returns an empty list for a valid board.
 */
export function validateBoard(board: Board): BoardProblem[] {
  const problems: BoardProblem[] = [];
  const add = (path: (string | number)[], message: string) =>
    problems.push({ path: formatPath(path), message });

  for (const [key, actor] of Object.entries(board.actors)) {
    if (actor.id !== key) add(['actors', key, 'id'], `does not match its key "${key}"`);
  }
  for (const [key, node] of Object.entries(board.nodes)) {
    if (node.id !== key) add(['nodes', key, 'id'], `does not match its key "${key}"`);
    if (node.parent === undefined) continue;
    const parent = board.nodes[node.parent];
    if (!parent) add(['nodes', key, 'parent'], `node "${node.parent}" does not exist`);
    else if (parent.type !== 'frame') {
      add(['nodes', key, 'parent'], `"${node.parent}" is a ${parent.type}, not a frame`);
    }
  }
  const reported = new Set<string>();
  for (const key of Object.keys(board.nodes).sort(compareStrings)) {
    const seen: string[] = [];
    let current: string | undefined = key;
    while (current !== undefined && !seen.includes(current)) {
      seen.push(current);
      current = board.nodes[current]?.parent;
    }
    if (current === undefined || reported.has(current)) continue;
    const cycle = seen.slice(seen.indexOf(current));
    for (const id of cycle) reported.add(id);
    add(
      ['nodes', current, 'parent'],
      `parent chain forms a cycle: ${cycle.join(' -> ')} -> ${current}`,
    );
  }

  const keys = new Map<string, string>();
  for (const key of Object.keys(board.edges).sort(compareStrings)) {
    const edge = board.edges[key] as BoardEdge;
    if (edge.id !== key) add(['edges', key, 'id'], `does not match its key "${key}"`);
    if (!board.nodes[edge.source])
      add(['edges', key, 'source'], `node "${edge.source}" does not exist`);
    if (!board.nodes[edge.target])
      add(['edges', key, 'target'], `node "${edge.target}" does not exist`);
    if (edge.source === edge.target) add(['edges', key], 'an edge cannot connect a node to itself');
    const edgeKey = `${edge.type}\u0000${edge.source}\u0000${edge.target}`;
    const other = keys.get(edgeKey);
    if (other !== undefined) {
      add(['edges', key], `duplicates edge "${other}" (same type, source and target)`);
    } else keys.set(edgeKey, key);
  }
  for (const key of Object.keys(board.nodes)) {
    if (board.edges[key]) add(['edges', key], `id "${key}" is also used by a node`);
  }
  // A comment may point at a node that no longer exists: it is kept, detached.
  for (const [key, comment] of Object.entries(board.comments ?? {})) {
    if (comment.id !== key) add(['comments', key, 'id'], `does not match its key "${key}"`);
  }
  return problems;
}

/**
 * Parse and validate board file text. Throws an `invalid_request`
 * `OpenBoardError` whose message names the path that failed.
 */
export function parseBoard(text: string): Board {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpenBoardError('invalid_request', `board file is not valid JSON: ${reason}`);
  }
  const parsed = BoardSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OpenBoardError(
      'invalid_request',
      `board file is invalid: ${formatIssues(parsed.error)}`,
      parsed.error.issues,
    );
  }
  const board = parsed.data;
  const problems = validateBoard(board);
  if (problems.length > 0) {
    const lines = problems.slice(0, 3).map((p) => `${p.path}: ${p.message}`);
    if (problems.length > 3) lines.push(`and ${problems.length - 3} more problems`);
    throw new OpenBoardError(
      'invalid_request',
      `board file is invalid: ${lines.join('; ')}`,
      problems,
    );
  }
  for (const [id, node] of Object.entries(board.nodes)) board.nodes[id] = normalizeNode(node);
  for (const [id, edge] of Object.entries(board.edges)) board.edges[id] = normalizeEdge(edge);
  if (board.comments && Object.keys(board.comments).length === 0) delete board.comments;
  return board;
}

/** A new board with nothing on it. */
export function emptyBoard(
  meta: { id: string; name: string; description?: string },
  now: Date = new Date(),
): Board {
  const id = IdSchema.safeParse(meta.id);
  if (!id.success) {
    throw new OpenBoardError('invalid_request', `invalid board id ${JSON.stringify(meta.id)}`);
  }
  const at = now.toISOString();
  const board = {
    schemaVersion: SCHEMA_VERSION,
    id: meta.id,
    name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
    createdAt: at,
    updatedAt: at,
    actors: {},
    nodes: {},
    edges: {},
  };
  const parsed = BoardSchema.safeParse(board);
  if (!parsed.success) {
    throw new OpenBoardError('invalid_request', `invalid board: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

// ── Project config ───────────────────────────────────────────────────────────

/**
 * `.openboard/config.json` as file text: fixed key order, agents sorted by id,
 * two-space indentation, a final newline. The same config always produces
 * byte-identical output.
 */
export function serializeConfig(config: ProjectConfig): string {
  const parsed = ProjectConfigSchema.parse(config);
  const agents = Object.keys(parsed.policy.agents)
    .sort(compareStrings)
    .map((id): [string, Value] => [id, parsed.policy.agents[id] as string]);
  const root = new Ordered([
    ['version', parsed.version],
    [
      'policy',
      new Ordered([
        ['default', parsed.policy.default],
        ['agents', new Ordered(agents)],
      ]),
    ],
  ]);
  return `${emit(root, '')}\n`;
}

/** Parse and validate config file text. Throws an `invalid_request` `OpenBoardError` naming the problem. */
export function parseConfig(text: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpenBoardError('invalid_request', `config file is not valid JSON: ${reason}`);
  }
  const parsed = ProjectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OpenBoardError(
      'invalid_request',
      `config file is invalid: ${formatIssues(parsed.error)}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}
