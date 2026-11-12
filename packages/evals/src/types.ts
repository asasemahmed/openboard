/**
 * The vocabulary of the harness: scenarios, the simulated person, checks, the
 * trace of what the agent did, and the runners that drive an agent.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  Actor,
  AnswerInput,
  Ask,
  Board,
  BoardApi,
  Decision,
  NodePatch,
  Op,
  PolicyMode,
  Proposal,
} from '@openboard/core';

// ── Trace ────────────────────────────────────────────────────────────────────

/** One `tools/call` as the agent sent it and as the board answered it. */
export interface ToolCallRecord {
  /** 1-based position among all tool calls of the run. */
  seq: number;
  /** Which MCP connection made it (an agent may open more than one). */
  connection: number;
  tool: string;
  args: Record<string, unknown>;
  /** The text the agent got back (all text content, joined). */
  text: string;
  isError: boolean;
  /** Milliseconds since the run started. */
  startedMs: number;
  durationMs: number;
  /** Estimated tokens of the arguments the agent wrote. */
  argsTokens: number;
  /** Estimated tokens of the result the agent read. */
  resultTokens: number;
}

export interface Trace {
  calls: ToolCallRecord[];
  /** MCP connections the agent opened. */
  connections: number;
  /** What the agent reported about itself at `initialize`, per connection. */
  clients: Array<{ name: string; version?: string }>;
  /** How often the agent asked for `tools/list`. */
  toolListRequests: number;
  /** Other MCP methods the agent used, by name. */
  otherRequests: Record<string, number>;
}

// ── The simulated person ─────────────────────────────────────────────────────

/** A node named in a script: by id, by title (exact), or by a key the setup stored. */
export type NodeRef = { id: string } | { title: string } | { key: string };

/** When a scripted event happens. The first condition that holds fires it. */
export interface Trigger {
  /** After the agent's n-th tool call (counting only `tools`, when given) has been answered. */
  afterCalls?: number;
  tools?: string[];
  /** This long after the run started. */
  afterMs?: number;
}

export type HumanAction =
  | { kind: 'comment'; body: string; on?: NodeRef; mentions?: string[] }
  | { kind: 'edit'; node: NodeRef; patch: NodePatch; reason?: string }
  | { kind: 'apply'; ops: Op[]; reason?: string }
  | { kind: 'select'; nodes: NodeRef[] };

export interface HumanEvent {
  name: string;
  at: Trigger;
  action: HumanAction;
}

export type ProposalRule =
  | 'accept'
  | 'reject'
  /** Return the decision, or null to leave the proposal pending. */
  | ((proposal: Proposal, board: Board) => Decision | null);

export type AskRule = AnswerInput | ((ask: Ask, board: Board) => AnswerInput | null);

/**
 * What the person on the board does during a run. Everything goes through the
 * API as a human actor, as the browser would.
 */
export interface HumanScript {
  /** Nodes selected on the canvas before the run starts. */
  select?: NodeRef[];
  /** How the person reviews every proposal the agent makes. */
  proposals?: { decide: ProposalRule; note?: string; delayMs?: number };
  /** How the person answers every question the agent asks. */
  asks?: { answer: AskRule; delayMs?: number };
  /** Edits, comments and selections made while the agent works. */
  events?: HumanEvent[];
}

export interface HumanLogEntry {
  /** Milliseconds since the run started. */
  atMs: number;
  what: string;
}

// ── Scenarios ────────────────────────────────────────────────────────────────

export interface SetupContext {
  /** The scenario's project directory (a fresh temp directory). */
  root: string;
  /** The board the scenario works on. */
  board: string;
  /** The person who owns the project. */
  owner: BoardApi;
  ownerActor: Actor;
  /** The agent under test, as an earlier session of it: what it made is its own. */
  agent: BoardApi;
  agentActor: Actor;
  /** Any other actor, for example a second agent. */
  api(actor: Actor): BoardApi;
  /** Write a file under the project root, creating directories. */
  writeFile(relative: string, content: string): Promise<void>;
  /** Apply ops and return ref -> id; throws unless the batch was applied. */
  apply(ops: Op[], options?: { as?: BoardApi; reason?: string }): Promise<Record<string, string>>;
  /** Set the project's review policy for agents. */
  setPolicy(mode: PolicyMode): Promise<void>;
  /** Ids the checks and the reference can look up later, by key. */
  ids: Record<string, string>;
  /** Numbers the checks can use later (for example the cost of reading everything). */
  metrics: Record<string, number>;
  /** Poll until `check` returns a truthy value. */
  waitFor<T>(
    check: () => T | Promise<T>,
    what: string,
    timeoutMs?: number,
  ): Promise<NonNullable<T>>;
}

export interface CheckContext {
  board: Board;
  /** The board as setup left it. */
  initial: Board;
  trace: Trace;
  ids: Record<string, string>;
  metrics: Record<string, number>;
  agentId: string;
  humanId: string;
  root: string;
  owner: BoardApi;
  boardId: string;
  /** What the agent said at the end, when the runner reports it. */
  finalText: string | undefined;
  human: HumanLogEntry[];
}

export interface CheckOutcome {
  pass: boolean;
  /** 0..1; defaults to 1 when passing and 0 when not. */
  score?: number;
  detail: string;
}

export interface Check {
  name: string;
  weight: number;
  run(ctx: CheckContext): CheckOutcome | Promise<CheckOutcome>;
}

/** What the scripted reference solution gets: an MCP client on the same endpoint an agent uses. */
export interface ReferenceContext {
  client: Client;
  /** Call a tool; throws when the result is a tool error, unless `allowError`. */
  call(
    tool: string,
    args?: Record<string, unknown>,
    options?: { allowError?: boolean },
  ): Promise<{ text: string; isError: boolean }>;
  /** Wait until the simulated person has finished reacting (decisions, answers). */
  settle(): Promise<void>;
  root: string;
}

export interface Budget {
  maxToolCalls?: number;
  /** Board tokens read and written, from the proxy. */
  maxBoardTokens?: number;
}

export interface Scenario {
  id: string;
  title: string;
  /** What the scenario measures, in a sentence or two. */
  description: string;
  tags: string[];
  setup(ctx: SetupContext): Promise<void>;
  prompt: string;
  human?: HumanScript;
  checks: Check[];
  budget?: Budget;
  timeoutMs?: number;
  /** The ideal run. Returns what an agent would say at the end. */
  reference(ctx: ReferenceContext): Promise<string>;
}

// ── Runners ──────────────────────────────────────────────────────────────────

export type McpConnection = { command: string; args: string[] } | { url: string };

export interface RunInput {
  prompt: string;
  cwd: string;
  mcp: McpConnection;
  systemAppend?: string;
  model?: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
  /** Aborted on timeout or Ctrl-C; the runner must stop its agent. */
  signal: AbortSignal;
  /** For in-process runners: the scenario, and a way to reach the board without a process. */
  scenario: Scenario;
  connect(): Promise<ReferenceContext>;
}

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Part of `inputTokens` read from or written to a prompt cache. */
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface RunOutput {
  ok: boolean;
  finalText?: string;
  turns?: number;
  usage?: RunUsage;
  error?: string;
}

export interface AgentRunner {
  name: string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  run(input: RunInput): Promise<RunOutput>;
}
