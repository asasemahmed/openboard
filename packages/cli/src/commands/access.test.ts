/**
 * Shared mode from the command line, against a real shared-mode server on
 * loopback. Commands with `OPENBOARD_TOKEN` and `--url` present the token, so
 * the server judges them by it even though they come from this machine.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Actor } from '@openboard/core';
import { connect } from '@openboard/sdk';
import { describe, expect, it } from 'vitest';
import { runHook } from '../hook.js';
import { startServer } from '../lib/server.js';
import { run } from '../program.js';
import { captureIo, serverWorks, tempDir } from '../testing/helpers.js';
import {
  accessInviteCommand,
  accessListCommand,
  accessRevokeCommand,
  whoamiCommand,
} from './access.js';
import { connectCommand, TOKEN_PLACEHOLDER } from './connect.js';
import { runChecks } from './doctor.js';
import { initCommand } from './init.js';
import { startCommand } from './start.js';

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const OWNER: Actor = { id: 'owner', kind: 'human', name: 'Owner' };
const TOKEN = /\bob_[a-z0-9]{16}_[A-Za-z0-9_-]{43,}\b/;

async function shared() {
  const root = await tempDir();
  await initCommand(captureIo(root));
  const server = await startServer({ root, port: 0, shared: true });
  return { root, server, close: () => server.close() };
}

describe.skipIf(!serverWorks)('access, whoami and --url', () => {
  it('invites a person and an agent, lists and revokes, and the token works through the SDK', async () => {
    const { root, server, close } = await shared();
    try {
      const person = captureIo(root);
      await accessInviteCommand(person, { root, label: "Ada's laptop", role: 'commenter' });
      expect(person.out()).toContain(
        `Invite link for "Ada's laptop" (commenter), valid until revoked:`,
      );
      expect(person.out()).toMatch(/\/join#ob_[a-z0-9]{16}_/);

      const agent = captureIo(root);
      await accessInviteCommand(agent, { root, agent: true, label: 'CI agent', expires: '24' });
      const out = agent.out();
      const token = TOKEN.exec(out)?.[0] as string;
      expect(token).toBeTruthy();
      expect(out.match(new RegExp(token, 'g'))).toHaveLength(1);
      expect(out).toContain('It is shown only now and cannot be recovered');
      expect(out).toContain(`${server.url}/mcp`);
      expect(out).toContain('openboard mcp --url');
      expect(out).toContain('Bearer ${OPENBOARD_TOKEN}');

      const viaSdk = connect({ url: server.url, token });
      const who = await viaSdk.whoami();
      expect(who).toMatchObject({ role: 'editor', via: 'token', shared: true });
      expect(who.actor.kind).toBe('agent');

      const list = captureIo(root);
      await accessListCommand(list, { root });
      expect(list.out()).toMatch(/^ID +LABEL +KIND +ROLE +ACTOR +STATE +EXPIRES +LAST USED$/m);
      expect(list.out()).toContain('CI agent');
      expect(list.out()).not.toMatch(TOKEN);

      const remote = captureIo(root, { OPENBOARD_TOKEN: token });
      remote.remoteUrl = server.url;
      await whoamiCommand(remote, { root });
      expect(remote.out()).toContain('Role: editor, with an access token');
      expect(remote.out()).toContain('Server: shared mode');

      const local = captureIo(root);
      await whoamiCommand(local, { root });
      expect(local.out()).toContain("Role: owner, trusted as the owner at the server's machine");

      const id = who.grantId as string;
      const revoked = captureIo(root);
      await accessRevokeCommand(revoked, id, { root });
      expect(revoked.out()).toContain('Revoked "CI agent" (agent, editor)');
      const after = captureIo(root, { OPENBOARD_TOKEN: token });
      expect(await run(['whoami', '--url', server.url], after)).toBe(1);
      expect(after.err()).toContain('set OPENBOARD_TOKEN to a valid token');
    } finally {
      await close();
    }
  });

  it('surfaces role refusals with the missing permission, and takes tokens from the environment only', async () => {
    const { root, server, close } = await shared();
    try {
      const { token } = await server
        .api(OWNER)
        .grantAccess({ label: 'Watcher', role: 'viewer', kind: 'agent' });
      const io = captureIo(root, { OPENBOARD_TOKEN: token });
      expect(await run(['boards', '--url', server.url], io)).toBe(0);
      expect(io.out()).toContain('main');
      const refused = captureIo(root, { OPENBOARD_TOKEN: token });
      expect(await run(['new', 'Spikes', '--url', server.url], refused)).toBe(1);
      expect(refused.err()).toMatch(
        /^openboard: your access \(viewer\) does not include "board\.create"/,
      );

      const flag = captureIo(root);
      expect(await run(['boards', '--url', server.url, '--token', token], flag)).toBe(1);
      expect(flag.err()).toContain('tokens are not accepted as flags');
      expect(flag.err()).not.toContain(token);
      expect(await run(['boards', `--token=${token}`], captureIo(root))).toBe(1);
    } finally {
      await close();
    }
  });

  it('refuses invites on a server that is not shared', async () => {
    const root = await tempDir();
    await initCommand(captureIo(root));
    const server = await startServer({ root, port: 0 });
    try {
      await expect(accessInviteCommand(captureIo(root), { root, agent: true })).rejects.toThrow(
        /not in shared mode/,
      );
      await expect(
        accessInviteCommand(captureIo(root), { root, agent: true, role: 'owner' }),
      ).rejects.toThrow('owner is for people only');
    } finally {
      await server.close();
    }
  });

  it('doctor reports shared mode, the public URL and the grants', async () => {
    const { root, server, close } = await shared();
    try {
      await server.api(OWNER).grantAccess({ label: 'Bot', role: 'editor', kind: 'agent' });
      const checks = await runChecks(captureIo(root), { root, app: { dir: root, built: true } });
      expect(checks.find((c) => c.label.startsWith('Shared mode'))?.label).toContain(server.url);
      expect(checks.find((c) => c.label.includes('active access grant'))?.label).toBe(
        '1 active access grant (0 for people, 1 for agents); see `openboard access list`',
      );
    } finally {
      await close();
    }
  });

  it('reports hook activity to a remote server with OPENBOARD_URL and OPENBOARD_TOKEN', async () => {
    const { server, close } = await shared();
    try {
      const { token } = await server
        .api(OWNER)
        .grantAccess({ label: 'Laptop agent', role: 'editor', kind: 'agent' });
      const elsewhere = await tempDir();
      const result = await runHook([], {
        stdin: [
          Buffer.from(
            JSON.stringify({
              hook_event_name: 'SessionStart',
              session_id: 'remote-1',
              cwd: elsewhere,
            }),
          ),
        ],
        env: { OPENBOARD_URL: server.url, OPENBOARD_TOKEN: token },
        cwd: elsewhere,
      });
      expect(result.sent).toMatchObject({ session: 'remote-1', kind: 'session_start' });
      const { sessions } = await server.api(OWNER).sessions();
      expect(sessions.find((s) => s.id === 'remote-1')?.actor).toMatch(/^laptop-agent/);
    } finally {
      await close();
    }
  });
});

describe('connect --remote and start', () => {
  it('prints remote setups with a placeholder, never a token', async () => {
    const io = captureIo(await tempDir(), {
      OPENBOARD_TOKEN: 'ob_aaaaaaaaaaaaaaaa_secretsecretsecretsecretsecretsecretsecret12',
    });
    await connectCommand(io, undefined, { remote: true, url: 'https://board.example.com' });
    const out = io.out();
    expect(out).toContain(
      'claude mcp add --transport http openboard https://board.example.com/mcp',
    );
    expect(out).toContain('"Authorization": "Bearer ${OPENBOARD_TOKEN}"');
    expect(out).toContain(TOKEN_PLACEHOLDER);
    expect(out).toContain('mcp --url https://board.example.com');
    expect(out).toContain('  or in .mcp.json:');
    expect(out).toContain('Cursor:\n  add to .cursor/mcp.json:');
    expect(out).toContain('Codex:\n  add to ~/.codex/config.toml:');
    expect(out).not.toMatch(/ob_[a-z0-9]{16}_/);
    const json = captureIo(await tempDir());
    await connectCommand(json, 'codex', {
      remote: true,
      url: 'https://board.example.com',
      json: true,
    });
    expect(JSON.parse(json.out()).agents.codex.config).toContain('env = { OPENBOARD_TOKEN =');
  });

  it('refuses a non-loopback bind without --share', async () => {
    const root = await tempDir();
    await expect(
      startCommand(captureIo(root), { root, host: '0.0.0.0', open: false }),
    ).rejects.toThrow(/add --share/);
    await expect(
      startCommand(captureIo(root), { root, publicUrl: 'https://x.example', open: false }),
    ).rejects.toThrow('--public-url only applies to shared mode');
  });
});

describe.skipIf(!serverWorks || !existsSync(BIN))('openboard mcp --url', () => {
  it("proxies to a remote server over stdio as the token's grant", async () => {
    const { server, close } = await shared();
    const { grant, token } = await server
      .api(OWNER)
      .grantAccess({ label: 'Remote editor', role: 'editor', kind: 'agent' });
    const elsewhere = await tempDir();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp', '--url', server.url],
      cwd: elsewhere,
      env: { ...process.env, OPENBOARD_TOKEN: token } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'board_apply',
        arguments: { ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'Hello' } }] },
      });
      const text = (result.content as { text: string }[])[0]?.text ?? '';
      expect(text).toMatch(/^Applied: added 1 node/);
      const id = /n=(n_\w+)/.exec(text)?.[1] as string;
      expect((await server.api(OWNER).getBoard('main')).nodes[id]?.createdBy).toBe(grant.actorId);
      expect(existsSync(`${elsewhere}/.openboard`)).toBe(false);

      await server.api(OWNER).revokeAccess(grant.id);
      const after = await client.callTool({ name: 'board_outline', arguments: {} });
      expect(after.isError).toBe(true);
      expect((after.content as { text: string }[])[0]?.text).toContain(
        'Your access to this OpenBoard was revoked',
      );
    } finally {
      await client.close();
      await close();
    }
  }, 20_000);
});

describe('a token and plain http', () => {
  it('never sends OPENBOARD_TOKEN over plain http to another machine', async () => {
    const root = await tempDir();
    const token = `ob_${'a'.repeat(16)}_${'b'.repeat(43)}`;
    for (const url of ['http://board.example.com', 'http://192.0.2.10:4747']) {
      const io = captureIo(root, { OPENBOARD_TOKEN: token });
      expect(await run(['boards', '--url', url], io)).toBe(1);
      expect(io.err()).toContain('refusing to send OPENBOARD_TOKEN');
      expect(io.err()).not.toContain(token);
    }
  });
});
