/**
 * Running one scenario: a temp project, a real board server on port 0, the
 * scenario's setup, the recording MCP endpoint, the simulated person, the
 * agent, then the checks over the final board and the trace. Everything that
 * was started is stopped again on success, failure, timeout and abort.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { connect as connectSocket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type Actor, type Board, type BoardApi, estimateTokens, type Op } from '@openboard/core';
import { actorForClient, createMcpServer, VERSION as MCP_VERSION } from '@openboard/mcp';
import { type OpenBoardServer, startServer } from '@openboard/server';
import { startEndpoint } from './endpoint.js';
import { HumanEngine } from './human.js';
import { DEFAULT_THRESHOLD, type RunResult, toResult, weightedScore } from './score.js';
import { openSelectionPublisher, type SelectionPublisher } from './selection.js';
import { Recorder, resultText } from './trace.js';
import { StreamTransport } from './transport.js';
import type {
  AgentRunner,
  CheckContext,
  ReferenceContext,
  RunOutput,
  Scenario,
  SetupContext,
} from './types.js';

export const BOARD = 'main';
export const HUMAN: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
/** The agent under test always works as this actor, whatever client it is, so scenarios can rely on it. */
export const AGENT_ID = 'eval-agent';
export const AGENT_SETUP_ACTOR: Actor = { id: AGENT_ID, kind: 'agent', name: 'Agent' };
export const REFERENCE_CLIENT = 'openboard-evals-reference';

export const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60_000;

export interface RunScenarioOptions {
  runner: AgentRunner;
  model?: string;
  /** 1-based, for the report. */
  repeat?: number;
  threshold?: number;
  /** Leave the project directory in place. */
  keep?: boolean;
  /** Multiplies the person's delays; 0 reacts at once. */
  delayScale?: number;
  /** Appended to the agent's system prompt (for example the agent guide). */
  systemAppend?: string;
  /** Overrides the scenario's own timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  /** How often the person looks at the board. */
  pollMs?: number;
  /** Where temp projects go; defaults to the OS temp dir. */
  tmpRoot?: string;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  check: () => T | Promise<T>,
  what: string,
  timeoutMs = 5000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    }
    await sleep(25);
  }
}

/** What every agent pays once per connection: the tool list and the server instructions. */
export interface ToolSurface {
  tools: number;
  toolsListTokens: number;
  instructionsTokens: number;
  total: number;
}

let surface: Promise<ToolSurface> | undefined;

/** Measure `tools/list` and the instructions exactly as an agent receives them. */
export function measureToolSurface(): Promise<ToolSurface> {
  surface ??= (async () => {
    const server = createMcpServer({
      resolveApi: () => {
        throw new Error('not used');
      },
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'openboard-evals-measure', version: '0' });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      const toolsListTokens = estimateTokens(JSON.stringify(tools));
      const instructionsTokens = estimateTokens(client.getInstructions() ?? '');
      return {
        tools: tools.length,
        toolsListTokens,
        instructionsTokens,
        total: toolsListTokens + instructionsTokens,
      };
    } finally {
      await client.close();
      await server.close();
    }
  })();
  return surface;
}

export { MCP_VERSION };

/** An MCP client on the endpoint's socket, for in-process runners. */
async function referenceContext(
  tcp: { host: string; port: number },
  root: string,
  settle: () => Promise<void>,
): Promise<ReferenceContext & { close(): Promise<void> }> {
  const socket = connectSocket(tcp);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const client = new Client({ name: REFERENCE_CLIENT, version: MCP_VERSION });
  await client.connect(new StreamTransport(socket));
  return {
    client,
    root,
    settle,
    async call(tool, args = {}, options = {}) {
      const result = await client.callTool({ name: tool, arguments: args });
      const { text, isError } = resultText(result);
      if (isError && !options.allowError) throw new Error(`${tool} failed: ${text}`);
      return { text, isError };
    },
    close: () => client.close(),
  };
}

function failedRun(scenario: Scenario, options: RunScenarioOptions, error: string): RunResult {
  return {
    scenario: scenario.id,
    title: scenario.title,
    runner: options.runner.name,
    ...(options.model ? { model: options.model } : {}),
    repeat: options.repeat ?? 1,
    score: 0,
    passed: false,
    toolCalls: 0,
    boardTokensIn: 0,
    boardTokensOut: 0,
    overheadTokens: 0,
    connections: 0,
    durationMs: 0,
    checks: [],
    calls: [],
    human: [],
    error,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface PreparedProject {
  root: string;
  server: OpenBoardServer;
  owner: BoardApi;
  setup: SetupContext;
  /** The board as setup left it, laid out. */
  initial: Board;
}

/**
 * A temp project with a running server, the board, and the scenario's setup
 * applied. What it starts is pushed onto `cleanups` as it goes, so a failure
 * half way still cleans up.
 */
export async function prepareProject(
  scenario: Scenario,
  options: { tmpRoot?: string; keep?: boolean },
  cleanups: Array<() => Promise<unknown>>,
  onRoot: (root: string) => void = () => {},
): Promise<PreparedProject> {
  const base = options.tmpRoot ?? tmpdir();
  await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(base, `openboard-eval-${scenario.id}-`)));
  onRoot(root);
  const projectRoot = root;
  if (!options.keep) cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));

  const server = await startServer({ root, port: 0 });
  cleanups.push(() => server.close());
  const owner = server.api(HUMAN);
  const agentSetup = server.api(AGENT_SETUP_ACTOR);
  await owner.createBoard({ id: BOARD, name: scenario.title });

  const setup: SetupContext = {
    root,
    board: BOARD,
    owner,
    ownerActor: HUMAN,
    agent: agentSetup,
    agentActor: AGENT_SETUP_ACTOR,
    api: (actor) => server.api(actor),
    async writeFile(relative, content) {
      const file = path.join(projectRoot, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    async apply(ops: Op[], opts: { as?: BoardApi; reason?: string } = {}) {
      const api = opts.as ?? owner;
      const result = await api.apply(BOARD, {
        ops,
        // Placed batch by batch, as they would be in use: one layout of a large board at once
        // can exceed what a single batch may hold.
        layout: 'auto',
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
      if (result.status !== 'applied') {
        throw new Error(
          `setup batch was ${result.status}: ${(result.errors ?? []).map((e) => e.message).join('; ')}`,
        );
      }
      return result.refs;
    },
    async setPolicy(mode) {
      await owner.setConfig({ version: 1, policy: { default: mode, agents: {} } });
    },
    ids: {},
    metrics: {},
    waitFor,
  };
  await scenario.setup(setup);
  const initial = await owner.getBoard(BOARD);
  setup.metrics.fullReadTokens ??= (
    await owner.read(BOARD, { detail: 'summary', maxTokens: 50_000 })
  ).tokens;
  return { root, server, owner, setup, initial };
}

/** Run one scenario once with one runner. Never throws: failures are in the result. */
export async function runScenario(
  scenario: Scenario,
  options: RunScenarioOptions,
): Promise<RunResult> {
  const log = options.log ?? (() => {});
  const cleanups: Array<() => Promise<unknown>> = [];
  const cleanup = async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  };
  let root = '';
  try {
    if (options.signal?.aborted) return failedRun(scenario, options, 'aborted before it started');
    const prepared = await prepareProject(scenario, options, cleanups, (r) => {
      root = r;
    });
    const { server, owner, setup, initial } = prepared;
    const projectRoot = prepared.root;

    const script = scenario.human ?? {};
    let publisher: SelectionPublisher | undefined;
    const needsSelection =
      (script.select?.length ?? 0) > 0 ||
      (script.events ?? []).some((e) => e.action.kind === 'select');
    if (needsSelection) {
      const opened = await openSelectionPublisher(server.url, BOARD, HUMAN);
      publisher = opened;
      cleanups.push(() => opened.close());
    }

    const recorder = new Recorder();
    const human = new HumanEngine(script, {
      api: owner,
      board: BOARD,
      ids: setup.ids,
      ...(publisher
        ? { publishSelection: (ids) => (publisher as SelectionPublisher).select(ids) }
        : {}),
      now: () => recorder.elapsed(),
      delayScale: options.delayScale ?? 1,
    });
    if (script.select?.length) {
      const ids = script.select.map((ref) => {
        const id =
          'key' in ref
            ? setup.ids[ref.key]
            : 'id' in ref
              ? ref.id
              : Object.values(initial.nodes).find((n) => n.title === ref.title)?.id;
        if (!id) throw new Error(`cannot select ${JSON.stringify(ref)}: no such node`);
        return id;
      });
      await publisher?.select(ids);
      await waitFor(
        async () => (await owner.selection(BOARD)).nodeIds.length === ids.length,
        'the selection to reach the server',
      );
    }

    recorder.hooks = {
      beforeCall: () => human.gate(),
      afterCall: (record) => human.onCall(record),
    };
    const endpoint = await startEndpoint({
      recorder,
      resolveApi: (client) =>
        server.api(actorForClient(client, { OPENBOARD_AGENT_ID: AGENT_ID }), {
          session: client.session,
        }),
    });
    cleanups.push(() => endpoint.close());

    const pollMs = options.pollMs ?? 50;
    let ticking = true;
    const ticker = (async () => {
      while (ticking) {
        await human.tick();
        await sleep(pollMs);
      }
    })();
    cleanups.push(async () => {
      ticking = false;
      await ticker;
    });
    const settle = async () => {
      // Two quiet looks in a row: nothing scheduled, nothing new on the board.
      let quiet = 0;
      while (quiet < 2) {
        await human.tick();
        quiet = human.busy() ? 0 : quiet + 1;
        if (quiet < 2) await sleep(pollMs);
      }
    };

    const timeoutMs = options.timeoutMs ?? scenario.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    cleanups.push(async () => options.signal?.removeEventListener('abort', onAbort));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    cleanups.push(async () => clearTimeout(timer));

    const references: Array<{ close(): Promise<void> }> = [];
    cleanups.push(() => Promise.all(references.map((r) => r.close().catch(() => {}))));
    log(`${scenario.id}: running ${options.runner.name} in ${root}`);
    let output: RunOutput;
    try {
      output = await options.runner.run({
        prompt: scenario.prompt,
        cwd: root,
        mcp: endpoint.stdio,
        ...(options.systemAppend !== undefined ? { systemAppend: options.systemAppend } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        timeoutMs,
        env: options.env ?? process.env,
        signal: controller.signal,
        scenario,
        connect: async () => {
          const ctx = await referenceContext(endpoint.tcp, projectRoot, settle);
          references.push(ctx);
          return ctx;
        },
      });
    } catch (error) {
      output = { ok: false, error: message(error) };
    }
    const durationMs = Math.round(recorder.elapsed());
    clearTimeout(timer);
    if (controller.signal.aborted) {
      const why = timedOut ? `timed out after ${timeoutMs} ms` : 'aborted';
      output = { ...output, ok: false, error: output.error ? `${why} (${output.error})` : why };
    }

    // Let the person finish: decisions on what is still pending, answers to open questions.
    if (!options.signal?.aborted) {
      await Promise.race([settle(), sleep(30_000)]);
    }

    const board = await owner.getBoard(BOARD);
    const trace = recorder.trace;
    const tools = await measureToolSurface();
    const ctx: CheckContext = {
      board,
      initial,
      trace,
      ids: setup.ids,
      metrics: setup.metrics,
      agentId: AGENT_ID,
      humanId: HUMAN.id,
      root,
      owner,
      boardId: BOARD,
      finalText: output.finalText,
      human: human.log,
    };
    const checks = [];
    for (const c of scenario.checks) {
      try {
        checks.push(toResult(c.name, c.weight, await c.run(ctx)));
      } catch (error) {
        checks.push(
          toResult(c.name, c.weight, { pass: false, detail: `check failed: ${message(error)}` }),
        );
      }
    }
    const score = weightedScore(checks);
    const errors = [
      ...(output.ok ? [] : [output.error ?? 'the agent run failed']),
      ...human.errors.map((e) => `person: ${e}`),
    ];
    const result: RunResult = {
      scenario: scenario.id,
      title: scenario.title,
      runner: options.runner.name,
      ...(options.model ? { model: options.model } : {}),
      repeat: options.repeat ?? 1,
      score,
      passed: score >= (options.threshold ?? DEFAULT_THRESHOLD) && output.ok,
      toolCalls: trace.calls.length,
      boardTokensIn: trace.calls.reduce((sum, call) => sum + call.resultTokens, 0),
      boardTokensOut: trace.calls.reduce((sum, call) => sum + call.argsTokens, 0),
      overheadTokens: tools.total * Math.max(1, trace.connections),
      connections: trace.connections,
      ...(output.turns !== undefined ? { turns: output.turns } : {}),
      ...(output.usage ? { usage: output.usage } : {}),
      durationMs,
      checks,
      calls: trace.calls.map((call) => ({
        seq: call.seq,
        tool: call.tool,
        isError: call.isError,
        argsTokens: call.argsTokens,
        resultTokens: call.resultTokens,
        durationMs: call.durationMs,
      })),
      human: human.log,
      ...(output.finalText !== undefined ? { finalText: output.finalText } : {}),
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
      ...(options.keep ? { keptPath: root } : {}),
    };
    return result;
  } catch (error) {
    const failed = failedRun(scenario, options, message(error));
    if (options.keep && root) failed.keptPath = root;
    return failed;
  } finally {
    await cleanup();
  }
}
