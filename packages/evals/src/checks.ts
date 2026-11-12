/**
 * Check helpers. Each returns a `Check`: a name, a weight, and a function over
 * the final board and the trace. Board checks look at what the agent left;
 * trace checks look at how it got there.
 */
import type { Board, BoardNode, Status } from '@openboard/core';
import {
  edgeBetween,
  findNodes,
  isInside,
  nodes,
  nodesLinkedTo,
  semantic,
  type TitleMatch,
  titleMatches,
  touchedIds,
} from './board.js';
import type { Budget, Check, CheckContext, CheckOutcome, ToolCallRecord } from './types.js';

/** How a check names a node: a title (or pattern), a key the setup stored, or a linked file. */
export type NodePick = TitleMatch | { key: string } | { link: string };

export interface PickFilter {
  type?: string;
  /** Inside this frame (any depth), named the same way. */
  in?: NodePick;
}

/** Tools that only read the board; their results are what reading costs. */
export const READ_TOOLS = [
  'board_list',
  'board_outline',
  'board_read',
  'board_changes',
  'board_selection',
  'board_inbox',
  'board_links',
] as const;

export function check(name: string, run: Check['run'], weight = 1): Check {
  return { name, weight, run };
}

function show(pick: NodePick): string {
  if (typeof pick === 'string') return JSON.stringify(pick);
  if (pick instanceof RegExp) return String(pick);
  if ('key' in pick) return `<${pick.key}>`;
  return `linked to ${pick.link}`;
}

export function pickNodes(
  ctx: CheckContext,
  board: Board,
  pick: NodePick,
  filter: PickFilter = {},
): BoardNode[] {
  let found: BoardNode[];
  if (typeof pick === 'string' || pick instanceof RegExp) found = findNodes(board, pick);
  else if ('key' in pick) {
    const id = ctx.ids[pick.key];
    const node = id ? board.nodes[id] : undefined;
    found = node ? [node] : [];
  } else found = nodesLinkedTo(board, pick.link);
  if (filter.type) found = found.filter((node) => node.type === filter.type);
  if (filter.in) {
    const frames = pickNodes(ctx, board, filter.in, { type: 'frame' });
    found = found.filter((node) => frames.some((frame) => isInside(board, node, frame.id)));
  }
  return found;
}

const outcome = (pass: boolean, detail: string, score?: number): CheckOutcome =>
  score === undefined ? { pass, detail } : { pass, detail, score };

/** Fraction-of-items outcome: passes when every item does. */
function fraction(items: Array<{ ok: boolean; label: string }>, what: string): CheckOutcome {
  const missing = items.filter((item) => !item.ok).map((item) => item.label);
  const score = items.length === 0 ? 1 : (items.length - missing.length) / items.length;
  return outcome(
    missing.length === 0,
    missing.length === 0
      ? `all ${items.length} ${what}`
      : `${items.length - missing.length} of ${items.length} ${what}; missing: ${missing.join(', ')}`,
    score,
  );
}

// ── Board ────────────────────────────────────────────────────────────────────

export function nodeExists(
  name: string,
  pick: NodePick,
  filter: PickFilter & { status?: Status; body?: RegExp } = {},
  weight = 1,
): Check {
  return check(
    name,
    (ctx) => {
      let found = pickNodes(ctx, ctx.board, pick, filter);
      if (found.length === 0) {
        return outcome(
          false,
          `no ${filter.type ?? 'node'} ${show(pick)}${filter.in ? ` in ${show(filter.in)}` : ''}`,
        );
      }
      if (filter.status) {
        const withStatus = found.filter((node) => node.status === filter.status);
        if (withStatus.length === 0) {
          return outcome(
            false,
            `${show(pick)} has status ${found[0]?.status ?? 'none'}, not ${filter.status}`,
          );
        }
        found = withStatus;
      }
      if (filter.body) {
        const pattern = filter.body;
        if (!found.some((node) => pattern.test(node.body ?? ''))) {
          return outcome(
            false,
            `${show(pick)} body does not match ${pattern}: ${JSON.stringify((found[0]?.body ?? '').slice(0, 160))}`,
          );
        }
      }
      return outcome(true, `found ${found.map((node) => JSON.stringify(node.title)).join(', ')}`);
    },
    weight,
  );
}

/** Each of several nodes exists; partial credit per node. */
export function allExist(
  name: string,
  picks: Array<{ pick: NodePick; filter?: PickFilter }>,
  weight = 1,
): Check {
  return check(
    name,
    (ctx) =>
      fraction(
        picks.map(({ pick, filter }) => ({
          ok: pickNodes(ctx, ctx.board, pick, filter).length > 0,
          label: `${filter?.type ?? 'node'} ${show(pick)}${filter?.in ? ` in ${show(filter.in)}` : ''}`,
        })),
        'nodes exist',
      ),
    weight,
  );
}

/** Each listed edge exists between some node matching `from` and some matching `to`. */
export function edgesExist(
  name: string,
  wanted: Array<{ from: NodePick; to: NodePick; type: string }>,
  weight = 1,
): Check {
  return check(
    name,
    (ctx) =>
      fraction(
        wanted.map(({ from, to, type }) => {
          const sources = pickNodes(ctx, ctx.board, from);
          const targets = pickNodes(ctx, ctx.board, to);
          const ok = sources.some((s) =>
            targets.some((t) => edgeBetween(ctx.board, s.id, t.id, type)),
          );
          return { ok, label: `${show(from)} -${type}-> ${show(to)}` };
        }),
        'edges exist',
      ),
    weight,
  );
}

/** No edge of `type` points the wrong way (from `to` to `from`). */
export function noReversedEdges(
  name: string,
  pairs: Array<{ from: NodePick; to: NodePick; type: string }>,
  weight = 1,
): Check {
  return check(
    name,
    (ctx) => {
      const reversed = pairs.filter(({ from, to, type }) =>
        pickNodes(ctx, ctx.board, to).some((s) =>
          pickNodes(ctx, ctx.board, from).some((t) => edgeBetween(ctx.board, s.id, t.id, type)),
        ),
      );
      return reversed.length === 0
        ? outcome(true, 'no edge points the wrong way')
        : outcome(
            false,
            `reversed: ${reversed.map((p) => `${show(p.to)} -${p.type}-> ${show(p.from)}`).join(', ')}`,
          );
    },
    weight,
  );
}

export function statusEquals(name: string, pick: NodePick, status: Status, weight = 1): Check {
  return check(
    name,
    (ctx) => {
      const found = pickNodes(ctx, ctx.board, pick);
      if (found.length === 0) return outcome(false, `no node ${show(pick)}`);
      const node = found[0] as BoardNode;
      return node.status === status
        ? outcome(true, `${JSON.stringify(node.title)} is ${status}`)
        : outcome(
            false,
            `${JSON.stringify(node.title)} is ${node.status ?? 'without status'}, not ${status}`,
          );
    },
    weight,
  );
}

/** Every listed file has a node linked to it (of `type`, inside the frame matching `in`). */
export function linkedNodes(
  name: string,
  files: Array<{ target: string; type?: string; in?: NodePick }>,
  weight = 1,
): Check {
  return check(
    name,
    (ctx) =>
      fraction(
        files.map((file) => ({
          ok:
            pickNodes(
              ctx,
              ctx.board,
              { link: file.target },
              {
                ...(file.type ? { type: file.type } : {}),
                ...(file.in ? { in: file.in } : {}),
              },
            ).length > 0,
          label: `${file.type ?? 'node'} linked to ${file.target}${file.in ? ` in ${show(file.in)}` : ''}`,
        })),
        'files are linked',
      ),
    weight,
  );
}

/** No two nodes of the same type share a title, apart from duplicates the setup made. */
export function noDuplicates(name = 'no duplicate nodes', weight = 1): Check {
  return check(
    name,
    (ctx) => {
      const key = (node: BoardNode) => `${node.type}\u0000${node.title.trim().toLowerCase()}`;
      const count = (board: Board) => {
        const counts = new Map<string, number>();
        for (const node of nodes(board)) counts.set(key(node), (counts.get(key(node)) ?? 0) + 1);
        return counts;
      };
      const before = count(ctx.initial);
      const dupes = [...count(ctx.board)]
        .filter(([k, n]) => n > Math.max(1, before.get(k) ?? 0))
        .map(([k, n]) => `${k.replace('\u0000', ' ')} x${n}`);
      return dupes.length === 0
        ? outcome(true, 'no duplicates')
        : outcome(false, `duplicates: ${dupes.join(', ')}`);
    },
    weight,
  );
}

/** Every non-frame node the agent added sits inside a frame (`frame`, when given). */
export function nothingOutsideFrame(name: string, frame?: NodePick, weight = 1): Check {
  return check(
    name,
    (ctx) => {
      const frames = frame ? pickNodes(ctx, ctx.board, frame, { type: 'frame' }) : [];
      const added = nodes(ctx.board).filter(
        (node) =>
          !ctx.initial.nodes[node.id] && node.createdBy === ctx.agentId && node.type !== 'frame',
      );
      const outside = added.filter((node) =>
        frame ? !frames.some((f) => isInside(ctx.board, node, f.id)) : !node.parent,
      );
      return outside.length === 0
        ? outcome(
            true,
            `all ${added.length} added nodes are inside ${frame ? show(frame) : 'a frame'}`,
          )
        : outcome(
            false,
            `outside: ${outside.map((node) => JSON.stringify(node.title)).join(', ')}`,
          );
    },
    weight,
  );
}

/** Nodes people made are still there and mean the same, except those listed. */
export function humanNodesUntouched(
  name = 'human-authored nodes untouched',
  except: NodePick[] = [],
  weight = 1,
): Check {
  return check(
    name,
    (ctx) => {
      const allowed = new Set(
        except.flatMap((pick) => pickNodes(ctx, ctx.initial, pick).map((n) => n.id)),
      );
      const theirs = nodes(ctx.initial).filter(
        (node) => ctx.initial.actors[node.createdBy]?.kind === 'human' && !allowed.has(node.id),
      );
      const changed = theirs.filter((node) => {
        const now = ctx.board.nodes[node.id];
        return !now || semantic(now) !== semantic(node);
      });
      return changed.length === 0
        ? outcome(true, `${theirs.length} nodes unchanged`)
        : outcome(
            false,
            `changed or removed: ${changed.map((node) => `${JSON.stringify(node.title)}${ctx.board.nodes[node.id] ? '' : ' (removed)'}`).join(', ')}`,
            1 - changed.length / Math.max(1, theirs.length),
          );
    },
    weight,
  );
}

/** These nodes are exactly as setup left them (presentation aside). */
export function nodesUnchanged(name: string, picks: NodePick[], weight = 1): Check {
  return check(
    name,
    (ctx) =>
      fraction(
        picks.flatMap((pick) => {
          const before = pickNodes(ctx, ctx.initial, pick);
          if (before.length === 0) return [{ ok: false, label: `${show(pick)} (not in setup)` }];
          return before.map((node) => {
            const now = ctx.board.nodes[node.id];
            return {
              ok: now !== undefined && semantic(now) === semantic(node),
              label: `${JSON.stringify(node.title)}${now ? ' changed' : ' removed'}`,
            };
          });
        }),
        'nodes unchanged',
      ),
    weight,
  );
}

/** Every node of the setup is still on the board. */
export function nothingRemoved(name = 'nothing was removed', weight = 1): Check {
  return check(
    name,
    (ctx) => {
      const gone = nodes(ctx.initial).filter((node) => !ctx.board.nodes[node.id]);
      return gone.length === 0
        ? outcome(true, `all ${nodes(ctx.initial).length} nodes are still there`)
        : outcome(false, `removed: ${gone.map((node) => JSON.stringify(node.title)).join(', ')}`);
    },
    weight,
  );
}

// ── Trace ────────────────────────────────────────────────────────────────────

/** Every op the agent sent with `board_apply`, with the call it came in. */
export function sentOps(ctx: {
  trace: CheckContext['trace'];
}): Array<{ call: ToolCallRecord; op: Record<string, unknown> }> {
  return ctx.trace.calls
    .filter((call) => call.tool === 'board_apply' && Array.isArray(call.args.ops))
    .flatMap((call) => (call.args.ops as Record<string, unknown>[]).map((op) => ({ call, op })));
}

const isProposed = (call: ToolCallRecord) =>
  call.tool === 'board_apply' && /^Proposed as /m.test(call.text);

export function calledTool(
  name: string,
  tool: string,
  options: { args?: (args: Record<string, unknown>) => boolean; atLeast?: number } = {},
  weight = 1,
): Check {
  return check(
    name,
    (ctx) => {
      const calls = ctx.trace.calls.filter(
        (call) => call.tool === tool && (!options.args || options.args(call.args)),
      );
      const atLeast = options.atLeast ?? 1;
      return calls.length >= atLeast
        ? outcome(true, `${tool} called ${calls.length}x`)
        : outcome(
            false,
            `${tool} called ${calls.length}x${options.args ? ' with the expected arguments' : ''}, wanted at least ${atLeast}`,
          );
    },
    weight,
  );
}

export function notCalled(name: string, tool: string, weight = 1): Check {
  return check(
    name,
    (ctx) => {
      const n = ctx.trace.calls.filter((call) => call.tool === tool).length;
      return n === 0 ? outcome(true, `${tool} not called`) : outcome(false, `${tool} called ${n}x`);
    },
    weight,
  );
}

/** The first call matching `first` comes before the first call matching `then` (which must exist). */
export function calledBefore(
  name: string,
  first: string | ((call: ToolCallRecord) => boolean),
  then: string | ((call: ToolCallRecord) => boolean),
  weight = 1,
): Check {
  const is = (m: typeof first) => (call: ToolCallRecord) =>
    typeof m === 'string' ? call.tool === m : m(call);
  return check(
    name,
    (ctx) => {
      const a = ctx.trace.calls.findIndex(is(first));
      const b = ctx.trace.calls.findIndex(is(then));
      const label = (m: typeof first) => (typeof m === 'string' ? m : 'the expected call');
      if (b < 0) return outcome(false, `${label(then)} never happened`);
      if (a < 0) return outcome(false, `${label(first)} never happened`);
      return a < b
        ? outcome(true, `call #${a + 1} before call #${b + 1}`)
        : outcome(
            false,
            `${label(then)} (call #${b + 1}) came before ${label(first)} (call #${a + 1})`,
          );
    },
    weight,
  );
}

/** "When the user says these": `board_selection` (or a selection read) before the first write. */
export function selectionBeforeActing(weight = 1): Check {
  return calledBefore(
    'read the selection before acting on "these"',
    (call) =>
      call.tool === 'board_selection' ||
      (call.tool === 'board_read' && call.args.selection === true),
    'board_apply',
    weight,
  );
}

/** A proposed batch was never sent again, and nothing it touched was removed or re-added instead. */
export function noResentProposal(weight = 1): Check {
  return check(
    'did not re-send a proposed batch or work around the review',
    (ctx) => {
      const problems: string[] = [];
      const proposed = ctx.trace.calls.filter(isProposed);
      for (const call of proposed) {
        const ops = JSON.stringify(call.args.ops);
        const touched = new Set(
          (call.args.ops as Record<string, unknown>[])
            .flatMap(touchedIds)
            .filter((id) => ctx.initial.nodes[id]),
        );
        for (const later of ctx.trace.calls.filter(
          (c) => c.seq > call.seq && c.tool === 'board_apply',
        )) {
          if (JSON.stringify(later.args.ops) === ops)
            problems.push(`call #${later.seq} re-sent the batch of call #${call.seq}`);
          for (const op of later.args.ops as Record<string, unknown>[]) {
            if (op.op === 'remove_node' && typeof op.id === 'string' && touched.has(op.id)) {
              problems.push(`call #${later.seq} removes ${op.id}, which the proposal changes`);
            }
          }
        }
      }
      return problems.length === 0
        ? outcome(
            true,
            `${proposed.length} proposal${proposed.length === 1 ? '' : 's'}, none re-sent`,
          )
        : outcome(false, problems.join('; '));
    },
    weight,
  );
}

/** No `move_node` and no `view` in any added node: layout places things. */
export function neverSentCoordinates(weight = 1): Check {
  return check(
    'never sent coordinates',
    (ctx) => {
      const bad = sentOps(ctx).filter(
        ({ op }) =>
          op.op === 'move_node' ||
          (op.op === 'add_node' &&
            typeof op.node === 'object' &&
            op.node !== null &&
            'view' in op.node),
      );
      return bad.length === 0
        ? outcome(true, 'no coordinates')
        : outcome(
            false,
            `${bad.length} ops placed nodes by hand (calls ${[...new Set(bad.map((b) => b.call.seq))].join(', ')})`,
          );
    },
    weight,
  );
}

/** `board_inbox` was called (after the first call matching `after`, when given). */
export function checkedInbox(
  name = 'checked the inbox',
  after?: (call: ToolCallRecord) => boolean,
  weight = 1,
): Check {
  return check(
    name,
    (ctx) => {
      const start = after ? ctx.trace.calls.findIndex(after) : -1;
      if (after && start < 0)
        return outcome(false, 'the call the inbox check should follow never happened');
      const inbox = ctx.trace.calls.slice(start + 1).filter((call) => call.tool === 'board_inbox');
      return inbox.length > 0
        ? outcome(true, `board_inbox called at #${inbox.map((c) => c.seq).join(', #')}`)
        : outcome(false, 'board_inbox was not called when it mattered');
    },
    weight,
  );
}

/** The node was claimed with `board_claim` before any `board_apply` that changes it. */
export function claimedBeforeEditing(pick: NodePick, weight = 1): Check {
  return check(
    `claimed ${show(pick)} before editing it`,
    (ctx) => {
      const node = pickNodes(ctx, ctx.initial, pick)[0];
      if (!node) return outcome(false, `no node ${show(pick)} in the setup`);
      const claim = ctx.trace.calls.find(
        (call) =>
          call.tool === 'board_claim' &&
          call.args.release !== true &&
          Array.isArray(call.args.nodeIds) &&
          call.args.nodeIds.includes(node.id) &&
          !call.isError,
      );
      const edit = sentOps(ctx).find(({ op }) => touchedIds(op).includes(node.id));
      if (!claim) return outcome(false, `${JSON.stringify(node.title)} was never claimed`);
      if (!edit)
        return outcome(false, `${JSON.stringify(node.title)} was claimed but never edited`);
      return claim.seq < edit.call.seq
        ? outcome(true, `claimed at #${claim.seq}, edited at #${edit.call.seq}`)
        : outcome(false, `edited at #${edit.call.seq} before the claim at #${claim.seq}`);
    },
    weight,
  );
}

/** Tokens the agent read from read tools, against what reading everything would cost (`metrics[fullKey]`). */
export function targetedReads(
  options: { fullKey?: string; goodFraction?: number; badFraction?: number } = {},
  weight = 1,
): Check {
  const fullKey = options.fullKey ?? 'fullReadTokens';
  const good = options.goodFraction ?? 0.1;
  const bad = options.badFraction ?? 0.6;
  return check(
    'read only what it needed',
    (ctx) => {
      const full = ctx.metrics[fullKey];
      if (!full) return outcome(false, `metric ${fullKey} was not recorded by the setup`);
      const read = ctx.trace.calls
        .filter((call) => (READ_TOOLS as readonly string[]).includes(call.tool))
        .reduce((sum, call) => sum + call.resultTokens, 0);
      const share = read / full;
      const score = share <= good ? 1 : share >= bad ? 0 : (bad - share) / (bad - good);
      return outcome(
        share <= good * 2,
        `read ${read} board tokens, ${(share * 100).toFixed(1)}% of the ${full} it costs to read everything`,
        score,
      );
    },
    weight,
  );
}

/** Tool calls and board tokens (read plus written) within the scenario's budget. */
export function withinBudget(budget: Budget, weight = 1): Check {
  return check(
    'stayed within budget',
    (ctx) => {
      const calls = ctx.trace.calls.length;
      const tokens = ctx.trace.calls.reduce(
        (sum, call) => sum + call.argsTokens + call.resultTokens,
        0,
      );
      const over: string[] = [];
      if (budget.maxToolCalls !== undefined && calls > budget.maxToolCalls) {
        over.push(`${calls} tool calls > ${budget.maxToolCalls}`);
      }
      if (budget.maxBoardTokens !== undefined && tokens > budget.maxBoardTokens) {
        over.push(`${tokens} board tokens > ${budget.maxBoardTokens}`);
      }
      return over.length === 0
        ? outcome(true, `${calls} tool calls, ${tokens} board tokens`)
        : outcome(false, over.join('; '));
    },
    weight,
  );
}

/** What the agent said at the end matches. Scored 1 when the runner reports no final text. */
export function finalTextMatches(name: string, pattern: RegExp, weight = 1): Check {
  return check(
    name,
    (ctx) => {
      if (ctx.finalText === undefined) return outcome(true, 'the runner reports no final text');
      return pattern.test(ctx.finalText)
        ? outcome(true, `final text matches ${pattern}`)
        : outcome(
            false,
            `final text does not match ${pattern}: ${JSON.stringify(ctx.finalText.slice(0, 200))}`,
          );
    },
    weight,
  );
}

/** Whether `title` names any of `nodes`, for scenario-specific checks. */
export function hasTitle(list: BoardNode[], title: TitleMatch): boolean {
  return list.some((node) => titleMatches(node.title, title));
}
