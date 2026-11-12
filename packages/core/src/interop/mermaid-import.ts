/**
 * Mermaid import: a practical subset of `flowchart` / `graph` syntax.
 *
 * Read: the direction header; front matter `title`; node declarations with the
 * common shapes (and `@{ shape, label }`), quoted or unquoted labels and entity
 * codes; links `-->`, `---`, `-.->`, `-.-`, `==>`, `===` (any length, with `o`
 * or `x` ends) with `|label|` or `-- label -->` text; chains (`A --> B --> C`);
 * `&` fan-out; `subgraph ... end`, nested, which become frames; `%%` comments.
 * `classDef`, `class`, `style`, `linkStyle` and `click` lines are skipped and
 * counted. Anything else becomes a warning; parsing never throws.
 */
import type { Op } from '../ops.js';
import { BUILTIN_EDGE_TYPES, LIMITS } from '../schema.js';
import {
  OPENERS,
  SHAPES,
  type Shape,
  type ShapeName,
  TYPE_BY_SHAPE,
  TYPE_BY_SHAPE_KEYWORD,
} from './mermaid-shapes.js';
import { clip, fitTitle, oneLine, typeWords } from './text.js';
import type { ImportResult } from './types.js';

type LinkKind = 'arrow' | 'open' | 'dotted' | 'thick';

interface ParsedNode {
  id: string;
  label?: string;
  type?: string;
}

interface ParsedLink {
  kind: LinkKind;
  label?: string;
}

interface Chain {
  groups: ParsedNode[][];
  links: ParsedLink[];
}

interface Item {
  id: string;
  title: string;
  type: string;
  frame?: string;
  isFrame: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  nbsp: ' ',
  num: '#',
};

/** Decode Mermaid entity codes (`#quot;`, `#35;`) and the HTML ones people write by hand. */
function decodeEntities(text: string): string {
  return text.replace(/[#&](#?)([A-Za-z]+|\d+|x[0-9a-fA-F]+);/g, (match, hash, body: string) => {
    if (/^\d+$/.test(body)) return safeCodePoint(Number(body), match);
    if (hash && /^x[0-9a-fA-F]+$/.test(body))
      return safeCodePoint(Number.parseInt(body.slice(1), 16), match);
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** Label text as a person reads it: entities decoded, `<br>` as a space, markdown-string backticks gone. */
function cleanLabel(raw: string): string {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1);
  text = text.replace(/<br\s*\/?>/gi, ' ');
  return oneLine(decodeEntities(text));
}

const OTHER_DIAGRAMS =
  /^(sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4\w*|zenuml|\w+-beta)\b/;

const EDGE_TYPE_BY_WORDS = new Map<string, string>(
  BUILTIN_EDGE_TYPES.flatMap((type) => [
    [typeWords(type), type],
    [type, type],
  ]),
);

// ── Scanner ──────────────────────────────────────────────────────────────────

const ID_CHAR = /[\p{L}\p{N}_]/u;

class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  get done(): boolean {
    return this.pos >= this.text.length;
  }

  skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos] as string)) this.pos++;
  }

  startsWith(token: string): boolean {
    return this.text.startsWith(token, this.pos);
  }

  /** Match a sticky regex at the current position and advance past it. */
  match(re: RegExp): RegExpExecArray | null {
    re.lastIndex = this.pos;
    const found = re.exec(this.text);
    if (found) this.pos = re.lastIndex;
    return found;
  }

  readId(): string {
    const start = this.pos;
    while (this.pos < this.text.length) {
      const char = this.text[this.pos] as string;
      if (ID_CHAR.test(char)) {
        this.pos++;
        continue;
      }
      // `-` and `.` belong to an id only between id characters, so `A-->B` still splits.
      const next = this.text[this.pos + 1];
      if (
        (char === '-' || char === '.') &&
        next !== undefined &&
        ID_CHAR.test(next) &&
        this.pos > start
      ) {
        this.pos++;
        continue;
      }
      break;
    }
    return this.text.slice(start, this.pos);
  }

  /** Text up to (not including) the first of `closers`; advances past the closer. */
  readUntil(closers: readonly string[]): { text: string; closer: string } | null {
    let best = -1;
    let which = '';
    for (const closer of closers) {
      const at = this.text.indexOf(closer, this.pos);
      if (at !== -1 && (best === -1 || at < best)) {
        best = at;
        which = closer;
      }
    }
    if (best === -1) return null;
    const text = this.text.slice(this.pos, best);
    this.pos = best + which.length;
    return { text, closer: which };
  }

  /** A `"quoted"` string; Mermaid strings cannot contain a quote. */
  readQuoted(): string | null {
    if (!this.startsWith('"')) return null;
    const end = this.text.indexOf('"', this.pos + 1);
    if (end === -1) return null;
    const text = this.text.slice(this.pos + 1, end);
    this.pos = end + 1;
    return text;
  }
}

const LINK_TOKEN = /<?(?:(-{2,}[>ox]|-{3,})|(={2,}[>ox]|={3,})|(-\.+-[>ox]?))/y;
const INLINE_OPEN = /<?(--|==|-\.)(?=\s)/y;
const INLINE_CLOSE: Record<string, RegExp> = {
  '--': /-{2,}[>ox]|-{3,}/g,
  '==': /={2,}[>ox]|={3,}/g,
  '-.': /\.-+[>ox]?/g,
};

function linkKind(token: string): LinkKind {
  if (token.includes('=')) return 'thick';
  if (token.includes('.')) return 'dotted';
  return /[>ox]$/.test(token) ? 'arrow' : 'open';
}

function parseShape(s: Scanner): { shape: Shape; label: string } | null {
  const start = s.pos;
  for (const shape of OPENERS) {
    if (!s.startsWith(shape.open)) continue;
    s.pos += shape.open.length;
    // `[/` and `[\` open both a parallelogram and a trapezoid; the closer decides.
    const closers = shape.open === '[/' || shape.open === '[\\' ? ['/]', '\\]'] : [shape.close];
    s.skipSpace();
    const quoted = s.readQuoted();
    let label: string;
    let closer: string;
    if (quoted !== null) {
      s.skipSpace();
      const found = closers.find((c) => s.startsWith(c));
      if (!found) {
        s.pos = start;
        return null;
      }
      s.pos += found.length;
      label = quoted;
      closer = found;
    } else {
      const found = s.readUntil(closers);
      if (!found) {
        s.pos = start;
        return null;
      }
      label = found.text;
      closer = found.closer;
    }
    const resolved =
      shape.open === '[/'
        ? closer === '/]'
          ? SHAPES.parallelogram
          : SHAPES.trapezoid
        : shape.open === '[\\'
          ? closer === '\\]'
            ? SHAPES.parallelogramAlt
            : SHAPES.trapezoidAlt
          : shape;
    return { shape: resolved, label };
  }
  return null;
}

/** `@{ shape: doc, label: "Spec" }` (Mermaid 11). */
function parseShapeObject(s: Scanner): { type?: string; label?: string } | null {
  if (!s.startsWith('@{')) return null;
  const end = s.text.indexOf('}', s.pos);
  if (end === -1) return null;
  const body = s.text.slice(s.pos + 2, end);
  s.pos = end + 1;
  const out: { type?: string; label?: string } = {};
  const shape = /(?:^|,)\s*shape\s*:\s*"?([\w-]+)"?/.exec(body);
  if (shape?.[1]) out.type = TYPE_BY_SHAPE_KEYWORD[shape[1].toLowerCase()] ?? 'note';
  const label = /(?:^|,)\s*label\s*:\s*(?:"([^"]*)"|([^,]*))/.exec(body);
  if (label) out.label = (label[1] ?? label[2] ?? '').trim();
  return out;
}

function parseNode(s: Scanner): ParsedNode | null {
  s.skipSpace();
  const id = s.readId();
  if (!id) return null;
  const node: ParsedNode = { id };
  const object = parseShapeObject(s);
  if (object) {
    if (object.label !== undefined) node.label = object.label;
    node.type = object.type ?? 'note';
  } else {
    const shaped = parseShape(s);
    if (shaped) {
      node.label = shaped.label;
      node.type = TYPE_BY_SHAPE[shaped.shape.name as ShapeName] ?? 'note';
    }
  }
  s.match(/:::[\w-]+/y);
  return node;
}

function parseGroup(s: Scanner): ParsedNode[] | null {
  const first = parseNode(s);
  if (!first) return null;
  const group = [first];
  for (;;) {
    const mark = s.pos;
    s.skipSpace();
    if (!s.startsWith('&')) {
      s.pos = mark;
      return group;
    }
    s.pos++;
    const next = parseNode(s);
    if (!next) return null;
    group.push(next);
  }
}

function parseLink(s: Scanner): ParsedLink | null {
  s.skipSpace();
  const token = s.match(LINK_TOKEN);
  if (token) {
    const link: ParsedLink = { kind: linkKind(token[0]) };
    const mark = s.pos;
    s.skipSpace();
    if (s.startsWith('|')) {
      s.pos++;
      s.skipSpace();
      const quoted = s.readQuoted();
      if (quoted !== null) {
        s.skipSpace();
        if (!s.startsWith('|')) return null;
        s.pos++;
        link.label = quoted;
      } else {
        const found = s.readUntil(['|']);
        if (!found) return null;
        link.label = found.text;
      }
    } else s.pos = mark;
    return link;
  }
  const open = s.match(INLINE_OPEN);
  if (!open) return null;
  const close = INLINE_CLOSE[open[1] as string] as RegExp;
  close.lastIndex = s.pos;
  const found = close.exec(s.text);
  if (!found) return null;
  const raw = s.text.slice(s.pos, found.index).trim();
  s.pos = found.index + found[0].length;
  const kind = open[1] === '==' ? 'thick' : open[1] === '-.' ? 'dotted' : linkKind(found[0]);
  const label =
    raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
  return { kind, label };
}

function parseChain(text: string): Chain | null {
  const s = new Scanner(text);
  const first = parseGroup(s);
  if (!first) return null;
  const chain: Chain = { groups: [first], links: [] };
  for (;;) {
    s.skipSpace();
    if (s.done) return chain;
    const link = parseLink(s);
    if (!link) return null;
    const group = parseGroup(s);
    if (!group) return null;
    chain.links.push(link);
    chain.groups.push(group);
  }
}

/** Split a line into statements at `;`, ignoring semicolons inside quotes. */
function statements(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) {
      out.push(current);
      current = '';
    } else current += char;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
}

function frontMatterTitle(lines: string[]): { title?: string; skip: number } {
  if (lines[0]?.trim() !== '---') return { skip: 0 };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return { skip: 0 };
  let title: string | undefined;
  for (const line of lines.slice(1, end)) {
    const found = /^title:\s*(.*)$/.exec(line.trim());
    if (!found) continue;
    const raw = (found[1] ?? '').trim();
    if (raw.startsWith('"')) {
      try {
        title = String(JSON.parse(raw));
      } catch {
        title = raw.slice(1, -1);
      }
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      title = raw.slice(1, -1).replace(/''/g, "'");
    } else title = raw;
  }
  return { ...(title ? { title } : {}), skip: end + 1 };
}

// ── Import ───────────────────────────────────────────────────────────────────

/** Read a Mermaid flowchart into operations that recreate it. */
export function fromMermaid(text: string): ImportResult {
  const warnings: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const front = frontMatterTitle(lines);

  const items = new Map<string, Item>();
  const order: string[] = [];
  const edges: Array<{ from: string; to: string; link: ParsedLink; line: number }> = [];
  const stack: string[] = [];
  let header = false;
  let styling = 0;
  let anonymous = 0;

  const touch = (node: ParsedNode, frame: string | undefined) => {
    let item = items.get(node.id);
    if (!item) {
      item = { id: node.id, title: node.id, type: 'note', isFrame: false };
      items.set(node.id, item);
      order.push(node.id);
    }
    if (!item.isFrame) {
      if (node.type !== undefined) item.type = node.type;
      if (node.label !== undefined) item.title = node.label;
      if (item.frame === undefined && frame !== undefined && frame !== node.id) item.frame = frame;
    }
  };

  const openFrame = (id: string, title: string) => {
    const parent = stack[stack.length - 1];
    const existing = items.get(id);
    if (existing?.isFrame) {
      warnings.push(`subgraph "${id}" is declared twice; its contents are merged.`);
    } else if (existing) {
      existing.isFrame = true;
      existing.title = title;
      existing.type = 'frame';
      if (parent !== undefined && parent !== id) existing.frame = parent;
      else delete existing.frame;
    } else {
      items.set(id, {
        id,
        title,
        type: 'frame',
        isFrame: true,
        ...(parent !== undefined ? { frame: parent } : {}),
      });
      order.push(id);
    }
    stack.push(id);
  };

  let stopped = false;
  lines.forEach((rawLine, index) => {
    if (index < front.skip || stopped) return;
    const lineNo = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('%%')) return;
    for (const statement of statements(trimmed)) {
      if (!header) {
        const head = /^(graph|flowchart)(?:\s+(TB|TD|BT|RL|LR))?\s*$/i.exec(statement);
        if (head) {
          header = true;
          continue;
        }
        if (/^(graph|flowchart)\b/i.test(statement)) {
          header = true;
          const rest = statement.replace(/^(graph|flowchart)\s*(TB|TD|BT|RL|LR)?\s*/i, '');
          if (rest) handle(rest, lineNo);
          continue;
        }
        if (OTHER_DIAGRAMS.test(statement)) {
          warnings.push(
            `line ${lineNo}: "${clip(statement, 40)}" is not a flowchart; only flowchart and graph diagrams are read.`,
          );
          stopped = true;
          return;
        }
        header = true;
        warnings.push(
          'the diagram has no "flowchart" or "graph" header; reading it as a flowchart.',
        );
      }
      handle(statement, lineNo);
    }
  });

  function handle(statement: string, lineNo: number): void {
    if (/^end$/i.test(statement)) {
      if (stack.length === 0) warnings.push(`line ${lineNo}: "end" without a subgraph; ignored.`);
      else stack.pop();
      return;
    }
    const subgraph = /^subgraph\b\s*(.*)$/i.exec(statement);
    if (subgraph) {
      const rest = (subgraph[1] ?? '').trim();
      const bracketed = /^([^\s[\]"]+)\s*\[\s*(?:"([^"]*)"|([^\]]*))\s*\]$/.exec(rest);
      if (bracketed) {
        openFrame(bracketed[1] as string, cleanLabel(bracketed[2] ?? bracketed[3] ?? ''));
      } else if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
        anonymous++;
        openFrame(`subgraph_${anonymous}`, cleanLabel(rest.slice(1, -1)));
      } else if (rest) {
        openFrame(rest, cleanLabel(rest));
      } else {
        anonymous++;
        openFrame(`subgraph_${anonymous}`, 'Subgraph');
      }
      return;
    }
    if (/^direction\s+(TB|TD|BT|RL|LR)$/i.test(statement)) return;
    if (/^(classDef|class|style|linkStyle|click)\b/.test(statement)) {
      styling++;
      return;
    }
    if (/^(accTitle|accDescr|title)\b\s*[:{]/.test(statement)) return;
    if (/^(graph|flowchart)\b/i.test(statement)) {
      warnings.push(`line ${lineNo}: a second diagram header; ignored.`);
      return;
    }
    const chain = parseChain(statement);
    if (!chain) {
      warnings.push(`line ${lineNo}: could not read "${clip(statement, 60)}"; skipped.`);
      return;
    }
    const frame = stack[stack.length - 1];
    for (const group of chain.groups) for (const node of group) touch(node, frame);
    chain.links.forEach((link, i) => {
      for (const from of chain.groups[i] ?? []) {
        for (const to of chain.groups[i + 1] ?? []) {
          edges.push({ from: from.id, to: to.id, link, line: lineNo });
        }
      }
    });
  }

  if (stack.length > 0) {
    warnings.push(`${stack.length} subgraph${stack.length === 1 ? ' is' : 's are'} missing "end".`);
  }
  if (styling > 0) {
    warnings.push(
      `skipped ${styling} styling line${styling === 1 ? '' : 's'} (classDef, class, style, linkStyle, click).`,
    );
  }

  return buildOps(items, order, edges, warnings, front.title);
}

function buildOps(
  items: Map<string, Item>,
  order: string[],
  edges: Array<{ from: string; to: string; link: ParsedLink; line: number }>,
  warnings: string[],
  title: string | undefined,
): ImportResult {
  const refs = new Map<string, string>();
  const frameOps: Op[] = [];
  const nodeOps: Op[] = [];
  let frames = 0;
  let nodes = 0;
  // Frames first, each after its parent, so every "$ref" points back.
  const frameOrder: string[] = [];
  const visit = (id: string, path: Set<string>) => {
    if (refs.has(id) || path.has(id)) return;
    path.add(id);
    const parent = (items.get(id) as Item).frame;
    if (parent !== undefined) visit(parent, path);
    refs.set(id, `f${++frames}`);
    frameOrder.push(id);
  };
  for (const id of order) if ((items.get(id) as Item).isFrame) visit(id, new Set());
  for (const id of order) {
    const item = items.get(id) as Item;
    if (!item.isFrame) refs.set(id, `n${++nodes}`);
  }
  const titleOf = (item: Item) => {
    const cleaned = item.isFrame ? item.title : cleanLabel(item.title);
    if (Array.from(cleaned).length > LIMITS.title) {
      warnings.push(`the title of "${clip(item.id, 40)}" was cut to ${LIMITS.title} characters.`);
    }
    return fitTitle(cleaned, item.id);
  };
  for (const id of [...frameOrder, ...order.filter((id) => !(items.get(id) as Item).isFrame)]) {
    const item = items.get(id) as Item;
    const parent = item.frame !== undefined ? refs.get(item.frame) : undefined;
    const op: Op = {
      op: 'add_node',
      ref: refs.get(id) as string,
      node: {
        type: item.isFrame ? 'frame' : item.type,
        title: titleOf(item),
        ...(parent !== undefined ? { parent: `$${parent}` } : {}),
      },
    };
    (item.isFrame ? frameOps : nodeOps).push(op);
  }

  const edgeOps: Op[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.from === edge.to) {
      warnings.push(
        `line ${edge.line}: a link from "${clip(edge.from, 40)}" to itself was skipped.`,
      );
      continue;
    }
    const words = edge.link.label !== undefined ? cleanLabel(edge.link.label) : '';
    const named = words ? EDGE_TYPE_BY_WORDS.get(words.toLowerCase()) : undefined;
    const type =
      named ??
      (edge.link.kind === 'thick'
        ? 'blocks'
        : edge.link.kind === 'arrow'
          ? 'flows_to'
          : 'relates_to');
    const key = `${type}\u0000${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) {
      warnings.push(
        `line ${edge.line}: a second ${typeWords(type)} link from "${clip(edge.from, 40)}" to "${clip(edge.to, 40)}" was skipped.`,
      );
      continue;
    }
    seen.add(key);
    const label = named || !words ? undefined : words;
    if (label !== undefined && Array.from(label).length > LIMITS.label) {
      warnings.push(`line ${edge.line}: a link label was cut to ${LIMITS.label} characters.`);
    }
    edgeOps.push({
      op: 'add_edge',
      edge: {
        type,
        source: `$${refs.get(edge.from)}`,
        target: `$${refs.get(edge.to)}`,
        ...(label !== undefined ? { label: clip(label, LIMITS.label) } : {}),
      },
    });
  }

  let ops = [...frameOps, ...nodeOps, ...edgeOps];
  if (ops.length > LIMITS.opsPerBatch) {
    warnings.push(
      `the diagram needs ${ops.length} operations but one batch holds ${LIMITS.opsPerBatch}; only the first ${LIMITS.opsPerBatch} were kept.`,
    );
    ops = ops.slice(0, LIMITS.opsPerBatch);
  }
  return { ops, warnings, ...(title ? { name: clip(oneLine(title), 120) } : {}) };
}
