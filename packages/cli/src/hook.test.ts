import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Actor } from '@openboard/core';
import { actorForClient } from '@openboard/mcp';
import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  hookActor,
  isOwnMachineUrl,
  mapClaudeCode,
  mapCursor,
  mapGeneric,
  postActivity,
  remoteTarget,
  runHook,
  shorten,
} from './hook.js';
import { startServer } from './lib/server.js';
import { serverWorks, tempDir } from './testing/helpers.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const SESSION = '3f2c9a4e-7b1d-4c8e-9f0a-1b2c3d4e5f60';
const CWD = '/home/ada/shop';

/** Shapes as Claude Code sends them on stdin (common fields plus the event's own). */
const common = {
  session_id: SESSION,
  transcript_path: `/home/ada/.claude/projects/shop/${SESSION}.jsonl`,
  cwd: CWD,
  permission_mode: 'default',
};
const fixtures = {
  sessionStart: { ...common, hook_event_name: 'SessionStart', source: 'startup' },
  sessionEnd: { ...common, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
  prompt: {
    ...common,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Refactor the payment module so that refunds go through the new ledger service',
  },
  bashPre: {
    ...common,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_01',
    tool_input: {
      command:
        'pnpm test --filter payments -- --reporter verbose && echo "all good, and this goes on and on"',
      description: 'Run the payment tests',
    },
  },
  bashPost: {
    ...common,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_01',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: 'secret output', stderr: '', interrupted: false },
  },
  readPost: {
    ...common,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: `${CWD}/src/payments/refund.ts` },
    tool_response: { file: { content: 'export const API_KEY = "sk-live-..."' } },
  },
  editFailure: {
    ...common,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Edit',
    tool_input: { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' },
    error: 'permission denied',
  },
  agentPre: {
    ...common,
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: {
      description: 'Find refund call sites',
      prompt: 'Search the whole repository for ...',
      subagent_type: 'Explore',
    },
  },
  subagentStart: {
    ...common,
    hook_event_name: 'SubagentStart',
    agent_id: 'agent-def456',
    agent_type: 'Explore',
  },
  subagentTool: {
    ...common,
    hook_event_name: 'PreToolUse',
    agent_id: 'agent-def456',
    agent_type: 'Explore',
    tool_name: 'Grep',
    tool_input: { pattern: 'refund\\(' },
  },
  subagentStop: {
    ...common,
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_id: 'agent-def456',
    agent_type: 'Explore',
    agent_transcript_path: '/home/ada/.claude/projects/shop/x/subagents/agent-def456.jsonl',
    last_assistant_message: 'Found 4 call sites.',
  },
  notification: {
    ...common,
    hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash',
    title: 'Permission needed',
    notification_type: 'permission_prompt',
  },
  stop: {
    ...common,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Done: refunds now use the ledger.',
  },
  preCompact: {
    ...common,
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    custom_instructions: null,
  },
};

describe('Claude Code events', () => {
  it('maps every recorded event, briefly and without contents', () => {
    const map = (input: Record<string, unknown>) => mapClaudeCode(input, {});
    expect(map(fixtures.sessionStart)).toEqual({ session: SESSION, kind: 'session_start' });
    expect(map(fixtures.sessionEnd)).toEqual({ session: SESSION, kind: 'session_end' });
    expect(map(fixtures.prompt)).toEqual({
      session: SESSION,
      kind: 'prompt',
      summary: `${fixtures.prompt.prompt.length} characters`,
    });
    expect(map(fixtures.bashPre)).toEqual({
      session: SESSION,
      kind: 'tool_start',
      tool: 'Bash',
      summary: 'pnpm test --filter payments -- --reporter verbose && echo "all good, and this g…',
    });
    expect(map(fixtures.bashPost)).toEqual({
      session: SESSION,
      kind: 'tool_end',
      tool: 'Bash',
      ok: true,
      summary: 'pnpm test',
    });
    expect(map(fixtures.readPost)).toEqual({
      session: SESSION,
      kind: 'tool_end',
      tool: 'Read',
      ok: true,
      summary: 'src/payments/refund.ts',
    });
    expect(map(fixtures.editFailure)).toMatchObject({
      kind: 'tool_end',
      ok: false,
      summary: '/etc/hosts',
    });
    expect(map(fixtures.agentPre)).toMatchObject({
      kind: 'tool_start',
      tool: 'Agent',
      summary: 'Find refund call sites',
    });
    expect(map(fixtures.subagentStart)).toEqual({
      session: 'agent-def456',
      parent: SESSION,
      kind: 'subagent_start',
      label: 'Explore',
    });
    expect(map(fixtures.subagentTool)).toEqual({
      session: 'agent-def456',
      parent: SESSION,
      kind: 'tool_start',
      tool: 'Grep',
      summary: 'refund\\(',
    });
    expect(map(fixtures.subagentStop)).toEqual({
      session: 'agent-def456',
      parent: SESSION,
      kind: 'subagent_end',
      label: 'Explore',
    });
    expect(map(fixtures.notification)).toEqual({
      session: SESSION,
      kind: 'note',
      summary: 'Claude needs your permission to use Bash',
    });
    expect(map(fixtures.stop)).toEqual({
      session: SESSION,
      kind: 'note',
      summary: 'finished its turn',
    });
    expect(map(fixtures.preCompact)).toBeNull();
    expect(map({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBeNull();

    const everything = JSON.stringify(Object.values(fixtures).map(map));
    for (const secret of [
      'secret output',
      'sk-live',
      'Search the whole repository',
      'ledger service',
      'Found 4',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('honours the detail and prompt switches', () => {
    expect(mapClaudeCode(fixtures.bashPre, { OPENBOARD_HOOK_DETAIL: 'off' })).toEqual({
      session: SESSION,
      kind: 'tool_start',
      tool: 'Bash',
    });
    expect(mapClaudeCode(fixtures.prompt, { OPENBOARD_HOOK_DETAIL: 'off' })).toEqual({
      session: SESSION,
      kind: 'prompt',
    });
    expect(mapClaudeCode(fixtures.prompt, { OPENBOARD_HOOK_PROMPTS: '1' })?.summary).toBe(
      shorten(fixtures.prompt.prompt),
    );
  });

  it('attributes events to the same actor as the MCP server', () => {
    const envs = [
      {},
      { OPENBOARD_AGENT_ID: 'reviewer', OPENBOARD_AGENT_NAME: 'Review agent' },
      { OPENBOARD_AGENT_ID: 'bad id!' },
    ];
    for (const env of envs) {
      expect(hookActor('claude-code', env)).toEqual(actorForClient({ name: 'claude-code' }, env));
      expect(hookActor('', env)).toEqual(actorForClient({ name: '' }, env));
    }
  });
});

describe('Cursor events', () => {
  const base = {
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    model: 'some-model',
    cursor_version: '2.0.0',
    workspace_roots: ['/home/ada/shop'],
    user_email: 'ada@example.com',
    transcript_path: null,
  };
  it('maps the events whose hooks may stay silent, and nothing else', () => {
    expect(mapCursor({ ...base, hook_event_name: 'sessionStart', session_id: 'conv-1' })).toEqual({
      session: 'conv-1',
      kind: 'session_start',
    });
    expect(
      mapCursor({
        ...base,
        hook_event_name: 'postToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/home/ada/shop/src/a.ts' },
        tool_output: '{"content":"secret"}',
        cwd: '/home/ada/shop',
      }),
    ).toEqual({ session: 'conv-1', kind: 'tool_end', tool: 'Read', ok: true, summary: 'src/a.ts' });
    expect(
      mapCursor({
        ...base,
        hook_event_name: 'postToolUseFailure',
        tool_name: 'Shell',
        error_message: 'x',
      }),
    ).toEqual({ session: 'conv-1', kind: 'tool_end', tool: 'Shell', ok: false });
    expect(mapCursor({ ...base, hook_event_name: 'stop', status: 'completed' })).toMatchObject({
      kind: 'note',
    });
    expect(
      mapCursor({ ...base, hook_event_name: 'sessionEnd', session_id: 'conv-1' }),
    ).toMatchObject({
      kind: 'session_end',
    });
    for (const name of [
      'preToolUse',
      'beforeShellExecution',
      'beforeReadFile',
      'subagentStart',
      'beforeSubmitPrompt',
    ]) {
      expect(mapCursor({ ...base, hook_event_name: name })).toBeNull();
    }
  });

  it('is told apart from Claude Code and generic events', () => {
    expect(detectFormat({ ...base, hook_event_name: 'postToolUse' })).toBe('cursor');
    expect(detectFormat(fixtures.bashPre)).toBe('claude-code');
    expect(detectFormat({ session: 's', kind: 'note' })).toBe('generic');
  });
});

describe('generic events', () => {
  it('takes an ActivityEvent as is, and drops what is not one', () => {
    expect(
      mapGeneric({
        session: 'ci-42',
        kind: 'tool_start',
        tool: 'deploy',
        summary: 'staging',
        extra: 1,
      }),
    ).toEqual({ session: 'ci-42', kind: 'tool_start', tool: 'deploy', summary: 'staging' });
    expect(
      mapGeneric(
        { session: 'ci-42', kind: 'tool_end', ok: false },
        { OPENBOARD_HOOK_DETAIL: 'off' },
      ),
    ).toEqual({
      session: 'ci-42',
      kind: 'tool_end',
      ok: false,
    });
    expect(mapGeneric({ session: 'ci-42', kind: 'explode' })).toBeNull();
    expect(mapGeneric({ kind: 'note' })).toBeNull();
  });
});

const stdin = (value: unknown) => Readable.from([Buffer.from(JSON.stringify(value))]);

describe('remote reporting', () => {
  it('sends a token only over https, or http on this machine', () => {
    const token = 'ob_aaaaaaaaaaaaaaaa_x';
    expect(
      remoteTarget({ OPENBOARD_URL: 'https://board.example.com', OPENBOARD_TOKEN: token }),
    ).toEqual({
      url: 'https://board.example.com',
      token,
    });
    expect(
      remoteTarget({ OPENBOARD_URL: 'http://127.0.0.1:4747', OPENBOARD_TOKEN: token })?.url,
    ).toBe('http://127.0.0.1:4747');
    expect(
      remoteTarget({ OPENBOARD_URL: 'http://board.example.com', OPENBOARD_TOKEN: token }),
    ).toBeUndefined();
    expect(remoteTarget({ OPENBOARD_URL: 'https://board.example.com' })).toBeUndefined();
  });
});

describe('runHook', () => {
  it('sends nothing without a running server, and never creates .openboard', async () => {
    const root = await tempDir();
    let posted = 0;
    const result = await runHook([], {
      stdin: stdin({ ...fixtures.bashPre, cwd: root }),
      env: {},
      cwd: root,
      post: async () => {
        posted++;
        return true;
      },
    });
    expect(result).toEqual({ code: 0 });
    expect(posted).toBe(0);
    expect(existsSync(path.join(root, '.openboard'))).toBe(false);
  });

  it("never posts to another machine that a project's server.json names", async () => {
    // A repository can ship .openboard/.local/server.json; its URL must not
    // turn the hook into a feed of the agent's commands to that host.
    const root = await tempDir();
    await mkdir(path.join(root, '.openboard', '.local'), { recursive: true });
    const posted: string[] = [];
    const run = async (url: string) => {
      await writeFile(
        path.join(root, '.openboard', '.local', 'server.json'),
        JSON.stringify({ pid: process.pid, port: 80, url, root }),
      );
      await runHook([], {
        stdin: stdin({ ...fixtures.bashPre, cwd: root }),
        env: {},
        cwd: root,
        post: async (target) => {
          posted.push(target);
          return true;
        },
      });
    };
    for (const url of [
      'http://attacker.example',
      'http://203.0.113.7:4747',
      'http://127.0.0.1.attacker.example:4747',
      'http://user@attacker.example',
      'https://attacker.example',
    ]) {
      await run(url);
    }
    expect(posted).toEqual([]);
    await run('http://127.0.0.1:4747');
    expect(posted).toEqual(['http://127.0.0.1:4747']);
    expect(isOwnMachineUrl('http://[::1]:4747')).toBe(true);
    expect(isOwnMachineUrl('http://localhost:4747')).toBe(true);
  });

  it('does nothing when switched off, and survives garbage', async () => {
    const root = await tempDir();
    const io = { env: { OPENBOARD_HOOK: 'off' }, cwd: root };
    expect(await runHook([], { ...io, stdin: stdin(fixtures.bashPre) })).toEqual({ code: 0 });
    expect(await runHook([], { stdin: Readable.from(['not json']), env: {}, cwd: root })).toEqual({
      code: 0,
    });
    expect(
      await runHook(['--format', 'nope'], { stdin: stdin(fixtures.bashPre), env: {}, cwd: root }),
    ).toEqual({ code: 0 });
  });

  it('gives up after the timeout when the server does not answer', async () => {
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = silent.address() as AddressInfo;
      const actor: Actor = { id: 'claude-code', kind: 'agent', name: 'Claude Code' };
      const started = Date.now();
      const ok = await postActivity(
        `http://127.0.0.1:${port}`,
        actor,
        { session: 's', kind: 'note' },
        150,
      );
      expect(ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
      // Nothing listens here at all.
      expect(await postActivity('http://127.0.0.1:9', actor, { session: 's', kind: 'note' })).toBe(
        false,
      );
    } finally {
      silent.closeAllConnections();
      await new Promise((resolve) => silent.close(resolve));
    }
  });
});

/** Run the built `openboard hook` with `input` on stdin. */
function runBin(args: string[], input: unknown, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [BIN, 'hook', ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

describe.skipIf(!serverWorks || !existsSync(BIN))('openboard hook, the built command', () => {
  it('reports to the running server, prints nothing, and exits 0', async () => {
    const root = await tempDir();
    await mkdir(path.join(root, '.openboard'), { recursive: true });
    const server = await startServer({ root, port: 0 });
    try {
      const nested = path.join(root, 'src');
      await mkdir(nested);
      for (const event of [fixtures.sessionStart, fixtures.bashPre, fixtures.subagentStart]) {
        const result = await runBin([], { ...event, cwd: nested });
        expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
      }
      const generic = await runBin(
        ['--format', 'generic'],
        { session: 'ci-7', kind: 'note', summary: 'deploy', cwd: root },
        { OPENBOARD_AGENT_ID: 'ci' },
      );
      expect(generic.stdout).toBe('');
      const { sessions } = await server.api({ id: 'ada', kind: 'human', name: 'Ada' }).sessions();
      const main = sessions.find((s) => s.id === SESSION);
      expect(main).toMatchObject({ actor: 'claude-code', children: ['agent-def456'] });
      expect(main?.current).toMatchObject({ tool: 'Bash' });
      expect(sessions.find((s) => s.id === 'agent-def456')).toMatchObject({
        parent: SESSION,
        label: 'Explore',
      });
      expect(sessions.find((s) => s.id === 'ci-7')).toMatchObject({ actor: 'ci' });
    } finally {
      await server.close();
    }
  });

  it('is silent with no server, bad input, and when switched off', async () => {
    const root = await tempDir();
    for (const [input, env] of [
      [{ ...fixtures.bashPre, cwd: root }, {}],
      ['{not json', {}],
      [fixtures.bashPre, { OPENBOARD_HOOK: 'off' }],
    ] as const) {
      expect(await runBin([], input, env)).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect(existsSync(path.join(root, '.openboard'))).toBe(false);
  });
});
