/**
 * The simulated person. It plays a `HumanScript` through the board API as a
 * human actor while the agent works: it reviews proposals, answers questions,
 * and makes the edits, comments and selections the script schedules.
 *
 * It keeps no clock of its own. The harness calls `tick()` every few
 * milliseconds and `onCall()` after every tool call; `now` is injected, so a
 * test can drive it step by step.
 */
import type { BoardApi, Decision, Proposal } from '@openboard/core';
import { resolveRef } from './board.js';
import type {
  HumanAction,
  HumanEvent,
  HumanLogEntry,
  HumanScript,
  ToolCallRecord,
} from './types.js';

export interface HumanDeps {
  /** A session as the person. */
  api: BoardApi;
  board: string;
  /** Ids the setup stored, for `{ key }` references. */
  ids: Record<string, string>;
  /** Publish a canvas selection (see `selection.ts`). */
  publishSelection?: (nodeIds: string[]) => Promise<void>;
  /** Milliseconds since the run started. */
  now: () => number;
  /** Multiplies every delay in the script; 0 reacts at once. Defaults to 1. */
  delayScale?: number;
}

interface Scheduled {
  due: number;
  what: string;
  run: () => Promise<void>;
}

export class HumanEngine {
  readonly log: HumanLogEntry[] = [];
  readonly errors: string[] = [];
  readonly #script: HumanScript;
  readonly #deps: HumanDeps;
  readonly #fired = new Set<string>();
  readonly #counts = new Map<string, number>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #seenProposals = new Set<string>();
  readonly #seenAsks = new Set<string>();
  #scheduled: Scheduled[] = [];
  #ticking: Promise<void> | undefined;

  constructor(script: HumanScript, deps: HumanDeps) {
    this.#script = script;
    this.#deps = deps;
  }

  #delay(ms: number | undefined): number {
    return Math.max(0, (ms ?? 0) * (this.#deps.delayScale ?? 1));
  }

  #note(what: string): void {
    this.log.push({ atMs: Math.round(this.#deps.now()), what });
  }

  #track(what: string, work: () => Promise<void>): Promise<void> {
    const promise = work()
      .catch((error: unknown) => {
        const message = `${what} failed: ${error instanceof Error ? error.message : String(error)}`;
        this.errors.push(message);
        this.#note(message);
      })
      .finally(() => this.#inflight.delete(promise));
    this.#inflight.add(promise);
    return promise;
  }

  #fire(event: HumanEvent): void {
    if (this.#fired.has(event.name)) return;
    this.#fired.add(event.name);
    void this.#track(event.name, async () => {
      await this.#act(event.action);
      this.#note(`${event.name}: ${describeAction(event.action)}`);
    });
  }

  /** After every tool call: fire the events it triggers. Their work holds the next call back. */
  onCall(record: ToolCallRecord): void {
    for (const event of this.#script.events ?? []) {
      const { afterCalls, tools } = event.at;
      if (afterCalls === undefined || this.#fired.has(event.name)) continue;
      if (tools && !tools.includes(record.tool)) continue;
      const count = (this.#counts.get(event.name) ?? 0) + 1;
      this.#counts.set(event.name, count);
      if (count >= afterCalls) this.#fire(event);
    }
  }

  /** Resolves once everything the person started has finished. */
  async gate(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight]);
  }

  /** Whether the person still has something scheduled or under way. */
  busy(): boolean {
    return this.#scheduled.length > 0 || this.#inflight.size > 0;
  }

  /** One step: look at the board, schedule reactions, run what is due. Never runs twice at once. */
  tick(): Promise<void> {
    this.#ticking ??= this.#tick().finally(() => {
      this.#ticking = undefined;
    });
    return this.#ticking;
  }

  async #tick(): Promise<void> {
    const now = this.#deps.now();
    for (const event of this.#script.events ?? []) {
      if (event.at.afterMs !== undefined && now >= this.#delay(event.at.afterMs)) this.#fire(event);
    }
    const { api, board } = this.#deps;
    const review = this.#script.proposals;
    if (review) {
      try {
        const pending = await api.proposals(board, { status: 'pending', maxTokens: 50_000 });
        for (const proposal of pending.proposals) {
          if (this.#seenProposals.has(proposal.id)) continue;
          this.#seenProposals.add(proposal.id);
          this.#scheduled.push({
            due: now + this.#delay(review.delayMs),
            what: `review ${proposal.id}`,
            run: () => this.#review(proposal.id),
          });
        }
      } catch (error) {
        this.errors.push(`listing proposals failed: ${String(error)}`);
      }
    }
    const answering = this.#script.asks;
    if (answering) {
      try {
        const open = await api.asks(board, { status: 'open', maxTokens: 50_000 });
        for (const ask of open.asks) {
          if (this.#seenAsks.has(ask.id)) continue;
          this.#seenAsks.add(ask.id);
          this.#scheduled.push({
            due: now + this.#delay(answering.delayMs),
            what: `answer ${ask.id}`,
            run: () => this.#answer(ask.id),
          });
        }
      } catch (error) {
        this.errors.push(`listing questions failed: ${String(error)}`);
      }
    }
    const due = this.#scheduled.filter((item) => item.due <= now);
    this.#scheduled = this.#scheduled.filter((item) => item.due > now);
    for (const item of due) await this.#track(item.what, item.run);
    await this.gate();
  }

  async #review(proposalId: string): Promise<void> {
    const review = this.#script.proposals;
    if (!review) return;
    const { api, board } = this.#deps;
    const all = await api.proposals(board, { status: 'pending', maxTokens: 50_000 });
    const proposal = all.proposals.find((p) => p.id === proposalId);
    if (!proposal) {
      this.#note(`proposal ${proposalId} was no longer pending`);
      return;
    }
    const decision = decide(review.decide, review.note, proposal, await api.getBoard(board));
    if (!decision) {
      this.#note(`left proposal ${proposalId} pending`);
      return;
    }
    await api.decideProposal(board, proposalId, decision);
    this.#note(
      `${decision.action === 'accept' ? 'accepted' : 'rejected'} proposal ${proposalId}${decision.note ? ` with the note ${JSON.stringify(decision.note)}` : ''}`,
    );
  }

  async #answer(askId: string): Promise<void> {
    const answering = this.#script.asks;
    if (!answering) return;
    const { api, board } = this.#deps;
    const ask = await api.askResult(board, askId);
    if (ask.status !== 'open') return;
    const answer =
      typeof answering.answer === 'function'
        ? answering.answer(ask, await api.getBoard(board))
        : answering.answer;
    if (!answer) {
      this.#note(`left question ${askId} open`);
      return;
    }
    await api.answerAsk(board, askId, answer);
    this.#note(`answered ${JSON.stringify(ask.question)} with ${JSON.stringify(answer)}`);
  }

  async #act(action: HumanAction): Promise<void> {
    const { api, board, ids } = this.#deps;
    const current = await api.getBoard(board);
    const resolve = (ref: Parameters<typeof resolveRef>[2]) => {
      const id = resolveRef(current, ids, ref);
      if (!id) throw new Error(`no node for ${JSON.stringify(ref)}`);
      return id;
    };
    switch (action.kind) {
      case 'comment': {
        await api.comment(board, {
          body: action.body,
          ...(action.on ? { nodeId: resolve(action.on) } : {}),
          ...(action.mentions ? { mentions: action.mentions } : {}),
        });
        return;
      }
      case 'edit': {
        const result = await api.apply(board, {
          ops: [{ op: 'update_node', id: resolve(action.node), patch: action.patch }],
          ...(action.reason ? { reason: action.reason } : {}),
        });
        if (result.status !== 'applied') throw new Error(`edit was ${result.status}`);
        return;
      }
      case 'apply': {
        const result = await api.apply(board, {
          ops: action.ops,
          ...(action.reason ? { reason: action.reason } : {}),
        });
        if (result.status !== 'applied') throw new Error(`batch was ${result.status}`);
        return;
      }
      case 'select': {
        if (!this.#deps.publishSelection) throw new Error('no way to publish a selection');
        await this.#deps.publishSelection(action.nodes.map(resolve));
        return;
      }
    }
  }
}

function decide(
  rule: NonNullable<HumanScript['proposals']>['decide'],
  note: string | undefined,
  proposal: Proposal,
  board: Parameters<Exclude<typeof rule, string>>[1],
): Decision | null {
  if (typeof rule === 'function') return rule(proposal, board);
  return { action: rule, ...(note !== undefined ? { note } : {}) };
}

export function describeAction(action: HumanAction): string {
  const ref = (r: unknown) => JSON.stringify(r);
  switch (action.kind) {
    case 'comment':
      return `comments ${JSON.stringify(action.body)}${action.on ? ` on ${ref(action.on)}` : ''}${action.mentions ? `, mentioning ${action.mentions.join(', ')}` : ''}`;
    case 'edit':
      return `edits ${ref(action.node)}: ${JSON.stringify(action.patch)}`;
    case 'apply':
      return `applies ${action.ops.length} op${action.ops.length === 1 ? '' : 's'}`;
    case 'select':
      return `selects ${action.nodes.map(ref).join(', ')}`;
  }
}

/** The script in words, for `show`. */
export function describeScript(script: HumanScript | undefined): string[] {
  if (!script) return ['(no simulated person)'];
  const lines: string[] = [];
  if (script.select)
    lines.push(
      `Before the run, selects ${script.select.map((r) => JSON.stringify(r)).join(', ')}.`,
    );
  if (script.proposals) {
    const how =
      typeof script.proposals.decide === 'function'
        ? 'decides each proposal by a rule'
        : `${script.proposals.decide}s every proposal`;
    lines.push(
      `${how[0]?.toUpperCase()}${how.slice(1)} after ${script.proposals.delayMs ?? 0} ms${script.proposals.note ? `, noting ${JSON.stringify(script.proposals.note)}` : ''}.`,
    );
  }
  if (script.asks) {
    const what =
      typeof script.asks.answer === 'function'
        ? 'by a rule'
        : `with ${JSON.stringify(script.asks.answer)}`;
    lines.push(`Answers every question ${what} after ${script.asks.delayMs ?? 0} ms.`);
  }
  for (const event of script.events ?? []) {
    const when = [
      event.at.afterCalls !== undefined
        ? `after call ${event.at.afterCalls}${event.at.tools ? ` of ${event.at.tools.join('/')}` : ''}`
        : undefined,
      event.at.afterMs !== undefined ? `after ${event.at.afterMs} ms` : undefined,
    ]
      .filter(Boolean)
      .join(' or ');
    lines.push(`${when[0]?.toUpperCase()}${when.slice(1)}: ${describeAction(event.action)}.`);
  }
  return lines;
}
