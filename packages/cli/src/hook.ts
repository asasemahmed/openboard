/**
 * `openboard hook`: the recorder agent hook systems call on every event.
 *
 * It runs on every tool call of an agent, so it is built to be cheap and
 * harmless: it imports nothing but Node built-ins (`bin.ts` loads it before
 * anything else), never writes to stdout (a hook's stdout can end up in the
 * agent's context), never fails, never starts a server and never creates
 * files. It reads one event as JSON from stdin, turns it into an
 * `ActivityEvent`, and posts it to the project's running server with a short
 * timeout. Without a running server it does nothing.
 *
 * What it sends is deliberately short: tool names, file paths, the start of a
 * shell command, a subagent's description; never file contents or prompts.
 * Environment switches:
 *   OPENBOARD_HOOK=off          send nothing
 *   OPENBOARD_HOOK_DETAIL=off   tool names only, no summaries
 *   OPENBOARD_HOOK_PROMPTS=1    include the start of each prompt (default: its length)
 *   OPENBOARD_AGENT_ID, OPENBOARD_AGENT_NAME   the actor, as for `openboard mcp`
 *   OPENBOARD_URL with OPENBOARD_TOKEN          report to that remote server instead
 *                                               (https, or http on this machine only)
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import type { ActivityEvent, Actor } from '@openboard/core';

/** How long the post to the server may take before the hook gives up. */
export const HOOK_TIMEOUT_MS = 300;
/** The same for a remote server, which is further away. */
export const REMOTE_HOOK_TIMEOUT_MS = 1000;
/** Events larger than this (a tool response with a whole file, say) are not read further. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
/** Longest summary the hook builds itself; the server cuts again. */
const SUMMARY_CHARS = 80;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const KINDS = new Set([
  'session_start',
  'session_end',
  'prompt',
  'tool_start',
  'tool_end',
  'subagent_start',
  'subagent_end',
  'note',
]);

export type HookFormat = 'claude-code' | 'cursor' | 'generic';
type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;

const isOff = (value: string | undefined) =>
  value !== undefined && ['off', '0', 'false', 'no'].includes(value.trim().toLowerCase());
const isOn = (value: string | undefined) =>
  value !== undefined && ['on', '1', 'true', 'yes'].includes(value.trim().toLowerCase());

/** One line, at most `max` characters, ending in an ellipsis when cut. */
export function shorten(text: string, max = SUMMARY_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** A valid session id from any string, or undefined. */
function sessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  if (ID.test(value)) return value;
  const cleaned = value
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
  return ID.test(cleaned) ? cleaned : undefined;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * The actor a client is attributed to; the same rule as `actorForClient` in
 * `@openboard/mcp`, repeated here so the hook does not load the MCP server.
 */
export function hookActor(clientName: string, env: Env): Actor {
  const envId = env.OPENBOARD_AGENT_ID?.trim();
  const fallbackId = clientName === '' ? 'agent' : clientName;
  const id = envId && ID.test(envId) ? envId : fallbackId;
  const readable =
    clientName === ''
      ? 'Agent'
      : clientName
          .split(/[-_.]+/)
          .filter(Boolean)
          .map((word) => word[0]?.toUpperCase() + word.slice(1))
          .join(' ');
  const name = (env.OPENBOARD_AGENT_NAME?.trim() || readable).slice(0, 80);
  return { id, kind: 'agent', name };
}

/** A path relative to `cwd` when it is inside it. */
function relative(file: string, cwd: string | undefined): string {
  if (cwd && path.isAbsolute(file)) {
    const rel = path.relative(cwd, file);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return file;
}

/** The short, privacy-conscious summary of one Claude Code tool call. */
export function toolSummary(tool: string, input: unknown, cwd?: string): string | undefined {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Json;
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'NotebookRead': {
      const file = str(args.file_path) ?? str(args.notebook_path);
      return file && shorten(relative(file, cwd), 160);
    }
    case 'Bash':
      return str(args.command) && shorten(str(args.command) as string);
    case 'Glob':
    case 'Grep':
      return str(args.pattern) && shorten(str(args.pattern) as string);
    case 'LS':
      return str(args.path) && shorten(relative(str(args.path) as string, cwd), 160);
    case 'WebFetch': {
      try {
        return new URL(str(args.url) ?? '').host || undefined;
      } catch {
        return undefined;
      }
    }
    case 'Agent':
    case 'Task':
      return shorten(str(args.description) ?? str(args.subagent_type) ?? '') || undefined;
    default:
      return undefined;
  }
}

/**
 * A Claude Code hook event as an `ActivityEvent`, or null for events that are
 * not recorded. Tool events from inside a subagent (they carry `agent_id`) go
 * to the subagent's session, with the main session as its parent.
 */
export function mapClaudeCode(input: Json, env: Env = {}): ActivityEvent | null {
  const main = sessionId(input.session_id);
  if (!main) return null;
  const detail = !isOff(env.OPENBOARD_HOOK_DETAIL);
  const agent = sessionId(input.agent_id);
  const cwd = str(input.cwd);
  const own = agent ? { session: agent, parent: main } : { session: main };
  const withSummary = (event: ActivityEvent, summary: string | undefined): ActivityEvent => {
    if (detail && summary) event.summary = summary;
    return event;
  };
  const tool = str(input.tool_name);
  switch (input.hook_event_name) {
    case 'SessionStart':
      return { session: main, kind: 'session_start' };
    case 'SessionEnd':
      return { session: main, kind: 'session_end' };
    case 'UserPromptSubmit': {
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      return withSummary(
        { ...own, kind: 'prompt' },
        isOn(env.OPENBOARD_HOOK_PROMPTS) ? shorten(prompt) : `${prompt.length} characters`,
      );
    }
    case 'PreToolUse':
      if (!tool) return null;
      return withSummary(
        { ...own, kind: 'tool_start', tool },
        toolSummary(tool, input.tool_input, cwd),
      );
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (!tool) return null;
      return withSummary(
        { ...own, kind: 'tool_end', tool, ok: input.hook_event_name === 'PostToolUse' },
        toolSummary(tool, input.tool_input, cwd),
      );
    case 'SubagentStart':
    case 'SubagentStop': {
      if (!agent) return null;
      const event: ActivityEvent = {
        session: agent,
        parent: main,
        kind: input.hook_event_name === 'SubagentStart' ? 'subagent_start' : 'subagent_end',
      };
      const type = str(input.agent_type);
      if (type) event.label = shorten(type);
      return event;
    }
    case 'Notification':
      return withSummary(
        { ...own, kind: 'note' },
        str(input.message) ? shorten(str(input.message) as string) : str(input.notification_type),
      );
    case 'Stop':
      return withSummary({ session: main, kind: 'note' }, 'finished its turn');
    default:
      return null;
  }
}

/**
 * A Cursor agent hook event as an `ActivityEvent`, or null. Only events whose
 * hooks may stay silent are mapped: Cursor treats a missing or invalid answer
 * from a permission hook (`preToolUse`, `beforeShellExecution`, ...) as a
 * refusal, so the recorder must never be installed on those.
 */
export function mapCursor(input: Json, env: Env = {}): ActivityEvent | null {
  const session = sessionId(input.conversation_id) ?? sessionId(input.session_id);
  if (!session) return null;
  const detail = !isOff(env.OPENBOARD_HOOK_DETAIL);
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  const cwd = str(input.cwd) ?? str(roots[0]);
  const tool = str(input.tool_name) ?? 'tool';
  let toolInput: unknown = input.tool_input;
  if (typeof toolInput === 'string') {
    try {
      toolInput = JSON.parse(toolInput);
    } catch {
      toolInput = undefined;
    }
  }
  switch (input.hook_event_name) {
    case 'sessionStart':
      return { session, kind: 'session_start' };
    case 'sessionEnd':
      return { session, kind: 'session_end' };
    case 'postToolUse':
    case 'postToolUseFailure': {
      const event: ActivityEvent = {
        session,
        kind: 'tool_end',
        tool,
        ok: input.hook_event_name === 'postToolUse',
      };
      const summary = detail ? toolSummary(tool, toolInput, cwd) : undefined;
      if (summary) event.summary = summary;
      return event;
    }
    case 'stop':
      return detail
        ? { session, kind: 'note', summary: 'finished its turn' }
        : { session, kind: 'note' };
    default:
      return null;
  }
}

/** Which format an event is in, when `--format` does not say. */
export function detectFormat(input: Json): HookFormat {
  if (typeof input.hook_event_name !== 'string') return 'generic';
  return 'conversation_id' in input || /^[a-z]/.test(input.hook_event_name)
    ? 'cursor'
    : 'claude-code';
}

/** The directory an event happened in. */
function eventCwd(input: Json): string | undefined {
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  return str(input.cwd) ?? str(roots[0]);
}

/** An `ActivityEvent` given as is (`--format generic`), checked loosely; null when it is not one. */
export function mapGeneric(input: Json, env: Env = {}): ActivityEvent | null {
  const session = sessionId(input.session);
  if (!session || typeof input.kind !== 'string' || !KINDS.has(input.kind)) return null;
  const event: ActivityEvent = { session, kind: input.kind as ActivityEvent['kind'] };
  const parent = sessionId(input.parent);
  if (parent) event.parent = parent;
  if (str(input.tool)) event.tool = shorten(str(input.tool) as string);
  if (typeof input.ok === 'boolean') event.ok = input.ok;
  if (str(input.label)) event.label = shorten(str(input.label) as string);
  if (str(input.at)) event.at = str(input.at) as string;
  if (str(input.summary) && !isOff(env.OPENBOARD_HOOK_DETAIL)) {
    event.summary = shorten(str(input.summary) as string, 200);
  }
  return event;
}

/** The project root for `cwd`: the nearest directory with `.openboard/`, else with `.git`, else `cwd`. */
export function hookRoot(cwd: string): string {
  const up = (test: (dir: string) => boolean): string | undefined => {
    let dir = path.resolve(cwd);
    for (;;) {
      if (test(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  };
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  return (
    up((dir) => isDir(path.join(dir, '.openboard'))) ??
    up((dir) => existsSync(path.join(dir, '.git'))) ??
    path.resolve(cwd)
  );
}

/** `OPENBOARD_URL` and `OPENBOARD_TOKEN`, when both are set and the URL is http(s). */
export function remoteTarget(env: Env): { url: string; token: string } | undefined {
  const url = env.OPENBOARD_URL?.trim();
  const token = env.OPENBOARD_TOKEN?.trim();
  if (!url || !token || !/^https?:\/\//.test(url)) return undefined;
  // Never send a token over plain http to another machine.
  if (url.startsWith('http://')) {
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return undefined;
    }
    if (!(host === 'localhost' || host === '::1' || /^127\./.test(host))) return undefined;
  }
  return { url, token };
}

/**
 * Whether `raw` is a plain http URL of this machine (a loopback name or an
 * interface address); the same rule as `isOwnMachineUrl` in the server.
 */
export function isOwnMachineUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  if (isIP(host) === 0) return false;
  return Object.values(networkInterfaces()).some((list) =>
    (list ?? []).some((entry) => entry.address.toLowerCase() === host),
  );
}

/**
 * The URL of the server recorded for `root`, or undefined. Reads one small
 * file. A repository can ship that file, so a URL that is not this machine's
 * is ignored: activity never goes to a host the project names.
 */
export function serverUrl(root: string): string | undefined {
  try {
    const info = JSON.parse(
      readFileSync(path.join(root, '.openboard', '.local', 'server.json'), 'utf8'),
    ) as { url?: unknown };
    return typeof info.url === 'string' && isOwnMachineUrl(info.url) ? info.url : undefined;
  } catch {
    return undefined;
  }
}

/** POST the event; resolves (never rejects) when done, failed, or after `timeoutMs`. */
export async function postActivity(
  url: string,
  actor: Actor,
  event: ActivityEvent,
  timeoutMs = HOOK_TIMEOUT_MS,
  token?: string,
): Promise<boolean> {
  // https only for a remote server; the local path stays on node:http.
  const send = url.startsWith('https://') ? (await import('node:https')).request : request;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const body = JSON.stringify(event);
    let req: ReturnType<typeof request>;
    try {
      req = send(new URL('/api/activity', url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-openboard-actor-id': actor.id,
          'x-openboard-actor-name': encodeURIComponent(actor.name),
          'x-openboard-actor-kind': actor.kind,
          'x-openboard-session': event.session,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      req.destroy();
      done(false);
    }, timeoutMs);
    req.on('response', (response) => {
      response.resume();
      response.on('end', () => done((response.statusCode ?? 500) < 300));
      response.on('error', () => done(false));
    });
    req.on('error', () => done(false));
    req.end(body);
  });
}

async function readAll(stdin: AsyncIterable<Buffer | string>): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface HookIo {
  stdin: AsyncIterable<Buffer | string>;
  env: Env;
  cwd: string;
  /** Replaces the network call, for tests. */
  post?: typeof postActivity;
}

/** `--format <name>` from the arguments after `hook`. */
function formatArg(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--format') return args[i + 1];
    if (arg.startsWith('--format=')) return arg.slice('--format='.length);
  }
  return undefined;
}

/**
 * Run the hook. Always resolves to 0: whatever goes wrong, the agent's tool
 * call must go on. Returns what was sent, for tests.
 */
export async function runHook(
  args: readonly string[],
  io: HookIo,
): Promise<{ code: 0; sent?: ActivityEvent }> {
  try {
    if (isOff(io.env.OPENBOARD_HOOK)) return { code: 0 };
    const text = await readAll(io.stdin);
    if (!text) return { code: 0 };
    const input = JSON.parse(text) as unknown;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return { code: 0 };
    const json = input as Json;
    const format = formatArg(args) ?? detectFormat(json);
    const event =
      format === 'claude-code'
        ? mapClaudeCode(json, io.env)
        : format === 'cursor'
          ? mapCursor(json, io.env)
          : format === 'generic'
            ? mapGeneric(json, io.env)
            : null;
    if (!event) return { code: 0 };
    // A remote server when OPENBOARD_URL and OPENBOARD_TOKEN say so, else the project's own.
    const remote = remoteTarget(io.env);
    const url = remote?.url ?? serverUrl(hookRoot(eventCwd(json) ?? io.cwd));
    if (!url) return { code: 0 };
    // The same actor the MCP server derives from the client's name (a remote server uses the grant's).
    const client = format === 'claude-code' ? 'claude-code' : format === 'cursor' ? 'cursor' : '';
    const actor = hookActor(client, io.env);
    await (io.post ?? postActivity)(
      url,
      actor,
      event,
      remote ? REMOTE_HOOK_TIMEOUT_MS : HOOK_TIMEOUT_MS,
      remote?.token,
    );
    return { code: 0, sent: event };
  } catch {
    return { code: 0 };
  }
}
