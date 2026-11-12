import { describe, expect, it } from 'vitest';
import { type Board, BUILTIN_NODE_TYPES } from '../schema.js';
import { applyToEmpty, build, HOSTILE, richBoard } from './fixtures.test.js';
import { mermaidIds, mermaidLabel, toMermaid } from './mermaid.js';
import { fromMermaid } from './mermaid-import.js';
import { oneLine } from './text.js';

/** Frame path of every node, by title: "Outer / Inner / Node". */
function structure(board: Board): string[] {
  const path = (id: string): string => {
    const node = board.nodes[id];
    if (!node) return '?';
    const own = oneLine(node.title);
    return node.parent ? `${path(node.parent)} / ${own}` : own;
  };
  return Object.keys(board.nodes).map(path).sort();
}

function edgeEnds(board: Board, withType = false): string[] {
  return Object.values(board.edges)
    .map((edge) => {
      const s = oneLine(board.nodes[edge.source]?.title ?? '?');
      const t = oneLine(board.nodes[edge.target]?.title ?? '?');
      return withType ? `${s} -${edge.type}-> ${t}` : `${s} -> ${t}`;
    })
    .sort();
}

describe('toMermaid', () => {
  const board = richBoard();
  const text = toMermaid(board);

  it('writes a flowchart with front matter, nested subgraphs and one line per node', () => {
    const lines = text.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      '---',
      'title: "Checkout <plan> & \\"more\\""',
      '---',
      'flowchart TD',
    ]);
    expect(toMermaid(board, { direction: 'LR' })).toContain('\nflowchart LR\n');
    expect(text).toContain('\n  subgraph n_1 ["Checkout"]\n    n_10{"Use Stripe"}\n');
    expect(text).toContain(
      '\n    subgraph n_2 ["Payment [API] #quot;v2#quot;"]\n      n_5("Payment API")\n',
    );
    expect(text).toContain('subgraph n_3 ["Later"]\n  end');
  });

  it('gives each type its own shape', () => {
    const ids = mermaidIds(Object.keys(board.nodes));
    const line = (title: string) => {
      const node = Object.values(board.nodes).find((n) => n.title === title);
      const id = ids.get(node?.id as string) as string;
      return text.split('\n').find((l) => l.trim().startsWith(`${id}`) && !l.includes('-->')) ?? '';
    };
    expect(line('Ship the checkout flow')).toMatch(/\["Ship the checkout flow"\]$/);
    expect(line('Payment API')).toMatch(/\("Payment API"\)$/);
    expect(line('Use Stripe')).toMatch(/\{"Use Stripe"\}$/);
    expect(line(HOSTILE.quotes)).toMatch(/\{\{".*"\}\}$/);
    expect(line(HOSTILE.brackets)).toMatch(/>".*"\]$/);
    expect(line('Payment spec')).toMatch(/\[\/"Payment spec"\/\]$/);
    expect(line('Session auth')).toMatch(/\[\["Session auth"\]\]$/);
    expect(line(HOSTILE.newline)).toMatch(/\(\[".*"\]\)$/);
    expect(line(HOSTILE.entity)).toMatch(/\[\/".*"\\\]$/);
  });

  it('styles edges by type and labels them', () => {
    expect(text).toMatch(/-\.->\|"relates to"\|/);
    expect(text).toMatch(/==>\|"blocks"\|/);
    expect(text).toMatch(/-->\|"depends on"\|/);
    expect(text).toMatch(/-->\|"see #quot;pricing#quot; #124; fees"\|/);
    expect(text).toMatch(/-->\|"mentions"\|/);
  });

  it('marks statuses with classes', () => {
    expect(text).toContain('classDef status_done ');
    expect(text).toMatch(/\n {2}class [\w,]+ status_in_progress\n/);
    expect(text).not.toContain('status_todo,');
  });

  it('escapes every label so no title can break out of its quotes', () => {
    for (const line of text.split('\n')) {
      // Every quote in a statement line pairs up, and no raw markup survives.
      if (line.startsWith('title:')) continue;
      expect((line.match(/"/g) ?? []).length % 2).toBe(0);
      expect(line).not.toMatch(/<b>|`/);
    }
    expect(mermaidLabel('a "b" <i>|c|</i> #1; `d`\ne')).toBe(
      '"a #quot;b#quot; #lt;i#gt;#124;c#124;#lt;/i#gt; #35;1; #96;d#96; e"',
    );
  });

  it('maps ids to safe, stable identifiers', () => {
    const ids = mermaidIds(['end', 'a.b', 'a:b', 'a-b', '9x', 'n_1', 'ok']);
    expect(ids.get('end')).toBe('n_end');
    expect(ids.get('9x')).toBe('n_9x');
    expect(ids.get('ok')).toBe('ok');
    expect(new Set(ids.values()).size).toBe(7);
    for (const id of ids.values()) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    expect(mermaidIds(['ok', 'a-b', 'a.b'])).toEqual(mermaidIds(['a.b', 'ok', 'a-b']));
  });
});

describe('fromMermaid', () => {
  it('round-trips titles, frame structure, types and edge endpoints', () => {
    const board = richBoard();
    const result = fromMermaid(toMermaid(board));
    expect(result.warnings).toEqual([
      'skipped 10 styling lines (classDef, class, style, linkStyle, click).',
    ]);
    expect(result.name).toBe(board.name);
    const back = applyToEmpty(result.ops);
    expect(structure(back)).toEqual(structure(board));
    expect(edgeEnds(back)).toEqual(edgeEnds(board));
    const custom = new Set(
      Object.values(board.nodes)
        .filter((n) => !(BUILTIN_NODE_TYPES as readonly string[]).includes(n.type))
        .map((n) => n.title),
    );
    const typeOf = (b: Board) =>
      Object.values(b.nodes)
        .filter((n) => !custom.has(n.title))
        .map((n) => `${oneLine(n.title)}:${n.type}`)
        .sort();
    expect(typeOf(back)).toEqual(typeOf(board));
    // Built-in edge types come back through their labels.
    const builtin = (b: Board) =>
      edgeEnds(b, true).filter((line) => !line.includes('x:') && !line.includes('flows_to'));
    expect(
      builtin(back).filter((l) => !l.includes('see also') && !l.includes('Stripe docs')),
    ).toEqual(builtin(board).filter((l) => !l.includes('see also') && !l.includes('Stripe docs')));
  });

  it('reads the practical subset of flowchart syntax', () => {
    const result = fromMermaid(`%% a comment
graph LR
  A[Start here] --> B(Rounded) --> C{Choose?}
  C -->|yes| D[[Sub]]
  C -- no way --> E>Flag]
  C -.-> F{{Hex}}
  C ==> G[/Doc/]
  A & B --- H([Pill]) & I[/Trap\\]
  X-->Y
  J["Quoted #quot;label#quot; with ; semicolon"]; K
  L@{ shape: doc, label: "New syntax" }
  subgraph outer [Outer box]
    direction TB
    M
    subgraph inner ["Inner #35;1"]
      N --> O
    end
  end
  subgraph Plain title
    P
  end
  classDef red fill:#f00
  class A red
  style B fill:#0f0
  click A "https://example.com"
  linkStyle 0 stroke:#000
`);
    expect(result.warnings).toEqual([
      'skipped 5 styling lines (classDef, class, style, linkStyle, click).',
    ]);
    const board = applyToEmpty(result.ops);
    const byTitle = new Map(Object.values(board.nodes).map((n) => [n.title, n]));
    expect(byTitle.get('Start here')?.type).toBe('note');
    expect(byTitle.get('Rounded')?.type).toBe('task');
    expect(byTitle.get('Choose?')?.type).toBe('decision');
    expect(byTitle.get('Sub')?.type).toBe('code');
    expect(byTitle.get('Flag')?.type).toBe('risk');
    expect(byTitle.get('Hex')?.type).toBe('question');
    expect(byTitle.get('Doc')?.type).toBe('doc');
    expect(byTitle.get('Pill')?.type).toBe('agent');
    expect(byTitle.get('Trap')?.type).toBe('run');
    expect(byTitle.get('New syntax')?.type).toBe('doc');
    expect(byTitle.get('Quoted "label" with ; semicolon')).toBeDefined();
    expect(byTitle.get('K')).toBeDefined();
    expect(structure(board)).toEqual(
      expect.arrayContaining([
        'Outer box / M',
        'Outer box / Inner #1 / N',
        'Outer box / Inner #1 / O',
        'Plain title / P',
      ]),
    );
    expect(edgeEnds(board, true)).toEqual(
      [
        'Start here -flows_to-> Rounded',
        'Rounded -flows_to-> Choose?',
        'Choose? -flows_to-> Sub',
        'Choose? -flows_to-> Flag',
        'Choose? -relates_to-> Hex',
        'Choose? -blocks-> Doc',
        'Start here -relates_to-> Pill',
        'Start here -relates_to-> Trap',
        'Rounded -relates_to-> Pill',
        'Rounded -relates_to-> Trap',
        'X -flows_to-> Y',
        'N -flows_to-> O',
      ].sort(),
    );
    const labels = Object.values(board.edges)
      .map((e) => e.label)
      .filter(Boolean)
      .sort();
    expect(labels).toEqual(['no way', 'yes']);
  });

  it('reports what it cannot read instead of throwing', () => {
    const result = fromMermaid(
      'flowchart TD\n  A --> B\n  this is ((( not valid\n  A --> A\n  A --> B\n  end\n  subgraph S\n',
    );
    expect(result.warnings).toEqual([
      'line 3: could not read "this is ((( not valid"; skipped.',
      '"end" without a subgraph; ignored.'.replace(/^/, 'line 6: '),
      '1 subgraph is missing "end".',
      'line 4: a link from "A" to itself was skipped.',
      'line 5: a second flows to link from "A" to "B" was skipped.',
    ]);
    applyToEmpty(result.ops);
  });

  it('declines other diagram types', () => {
    const result = fromMermaid('sequenceDiagram\n  Alice->>Bob: hi');
    expect(result.ops).toEqual([]);
    expect(result.warnings[0]).toMatch(/not a flowchart/);
  });

  it('reads a diagram without a header, with a warning', () => {
    const result = fromMermaid('A --> B');
    expect(result.warnings[0]).toMatch(/no "flowchart" or "graph" header/);
    expect(result.ops).toHaveLength(3);
  });

  it('keeps titles within the schema limits', () => {
    const long = 'x'.repeat(300);
    const result = fromMermaid(`flowchart TD\n  A["${long}"] -->|${'y'.repeat(200)}| B`);
    const board = applyToEmpty(result.ops);
    expect(Object.values(board.nodes).some((n) => n.title.length === 200)).toBe(true);
    expect(result.warnings.some((w) => w.includes('cut to 200'))).toBe(true);
  });

  it('never throws and always produces ops that apply, whatever the input', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pieces = [
      'A',
      'B',
      '-->',
      '---',
      '-.->',
      '==>',
      '|x|',
      '[',
      ']',
      '(',
      ')',
      '{',
      '}',
      '"',
      '&',
      ';',
      'subgraph',
      'end',
      '%%',
      ' ',
      '\n',
      'graph TD',
      '>',
      '/',
      '\\',
      ':::c',
      '@{',
      'é',
      '#quot;',
      '-- t -->',
    ];
    for (let i = 0; i < 300; i++) {
      const length = 1 + Math.floor(random() * 30);
      let text = '';
      for (let j = 0; j < length; j++) text += pieces[Math.floor(random() * pieces.length)];
      const result = fromMermaid(text);
      expect(() =>
        applyToEmpty(
          result.ops.length ? result.ops : [{ op: 'add_node', node: { type: 'note', title: 'x' } }],
        ),
      ).not.toThrow();
    }
  });

  it('round-trips an empty board and a board with only frames', () => {
    expect(fromMermaid(toMermaid(build([]))).ops).toEqual([]);
    const frames = build([
      { op: 'add_node', ref: 'a', node: { type: 'frame', title: 'A' } },
      { op: 'add_node', node: { type: 'frame', title: 'B', parent: '$a' } },
    ]);
    expect(structure(applyToEmpty(fromMermaid(toMermaid(frames)).ops))).toEqual(['A', 'A / B']);
  });
});
