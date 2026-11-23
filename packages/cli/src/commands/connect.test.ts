import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shellQuote } from '../lib/mcp.js';
import { captureIo, tempDir } from '../testing/helpers.js';
import { connectCommand } from './connect.js';

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const NODE = process.execPath;

async function connectOutput(agent: string | undefined, root: string, json = false) {
  const io = captureIo(root);
  expect(await connectCommand(io, agent, { root, json })).toBe(0);
  expect(io.err()).toBe('');
  return io.out();
}

describe('connect', () => {
  it('prints the Claude Code command and the .mcp.json block', async () => {
    const root = await tempDir();
    const out = await connectOutput('claude-code', root);
    expect(out).toContain(`Claude Code, for the boards in ${root}:`);
    expect(out).toContain(`  claude mcp add openboard -- ${NODE} ${BIN} mcp --root ${root}\n`);
    expect(out).toContain('Or add this to .mcp.json in the project root:');
    expect(out).toContain('    "mcpServers": {');
    expect(out).toContain(`        "command": ${JSON.stringify(NODE)},`);
    expect(out).toContain(`          ${JSON.stringify(BIN)},`);
  });

  it('prints the Cursor and Codex config blocks', async () => {
    const root = await tempDir();
    const cursor = await connectOutput('cursor', root);
    expect(cursor).toContain('Add this to .cursor/mcp.json:');
    expect(cursor).toContain('"openboard": {');

    const codex = await connectOutput('codex', root);
    expect(codex).toContain('Add this to ~/.codex/config.toml:');
    expect(codex).toContain('  [mcp_servers.openboard]\n');
    expect(codex).toContain(`  command = ${JSON.stringify(NODE)}\n`);
    expect(codex).toContain(
      `  args = [${JSON.stringify(BIN)}, "mcp", "--root", ${JSON.stringify(root)}]\n`,
    );
  });

  it('prints the Gemini CLI command and the .gemini/settings.json block', async () => {
    const root = await tempDir();
    const out = await connectOutput('gemini-cli', root);
    expect(out).toContain(`Gemini CLI, for the boards in ${root}:`);
    expect(out).toContain(
      `  gemini mcp add openboard ${shellQuote(NODE)} ${shellQuote(BIN)} mcp --root ${shellQuote(root)}\n`,
    );
    expect(out).toContain('Or add this to .gemini/settings.json:');
    expect(out).toContain('    \"mcpServers\": {');
    expect(out).toContain(`        \"command\": ${JSON.stringify(NODE)},`);
  });

  it('prints the local OpenCode V2 config without writing it', async () => {
    const root = path.join(await tempDir(), "my team's project");
    await mkdir(root);
    const out = await connectOutput('opencode', root);
    expect(out).toContain('Add this to opencode.json:');

    const { agents } = JSON.parse(await connectOutput('opencode', root, true));
    expect(Object.keys(agents)).toEqual(['opencode']);
    expect(JSON.parse(agents.opencode.config)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        servers: {
          openboard: { type: 'local', command: [NODE, BIN, 'mcp', '--root', root] },
        },
      },
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('prints the remote OpenCode bridge without disclosing the token', async () => {
    const root = await tempDir();
    const options = { remote: true, url: 'https://board.example.com/' };
    const token = 'dummy-token-for-opencode-test';
    const io = captureIo(root, { OPENBOARD_TOKEN: token });
    expect(await connectCommand(io, 'opencode', { ...options, json: true })).toBe(0);
    expect(io.out()).not.toContain(token);
    const { agents } = JSON.parse(io.out());
    expect(Object.keys(agents)).toEqual(['opencode']);
    expect(JSON.parse(agents.opencode.config)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        servers: {
          openboard: {
            type: 'local',
            command: [NODE, BIN, 'mcp', '--url', 'https://board.example.com'],
            environment: { OPENBOARD_TOKEN: '{env:OPENBOARD_TOKEN}' },
          },
        },
      },
    });

    const human = captureIo(root, { OPENBOARD_TOKEN: token });
    expect(await connectCommand(human, 'opencode', options)).toBe(0);
    expect(human.out()).toContain('OpenCode:\n  add to opencode.json:');
    expect(human.out()).not.toContain(token);
  });

  it('prints the stdio command and the HTTP URL for any client', async () => {
    const root = await tempDir();
    const out = await connectOutput('generic', root);
    expect(out).toContain(`  ${NODE} ${BIN} mcp --root ${root}\n`);
    expect(out).toContain('Over Streamable HTTP (while `openboard start` runs');
    expect(out).toContain('  http://127.0.0.1:4747/mcp\n');
  });

  it('prints every agent briefly without an argument', async () => {
    const root = await tempDir();
    const out = await connectOutput(undefined, root);
    const lines = out.split('\n');
    expect(lines[0]).toBe(`Connect an agent to the boards in ${root}:`);
    expect(lines).toContain(
      `  Claude Code  claude mcp add openboard -- ${NODE} ${BIN} mcp --root ${root}`,
    );
    expect(out).toMatch(/ {2}Cursor {7}add to \.cursor\/mcp\.json: \{ "mcpServers": \{/);
    expect(out).toMatch(/ {2}Codex {8}add to ~\/\.codex\/config\.toml: \[mcp_servers\.openboard\]/);
    expect(out).toMatch(/ {2}Gemini CLI {3}add to \.gemini\/settings\.json: \{ "mcpServers": \{/);
    expect(out).toMatch(/ {2}OpenCode {5}add to opencode\.json: \{ "\$schema": /);
    expect(
      lines.filter((line) => /^  \S/.test(line)).map((line) => line.trim().split(/ {2,}/)[0]),
    ).toEqual(['Claude Code', 'Cursor', 'Codex', 'Gemini CLI', 'OpenCode', 'Other']);
    expect(out).toContain(`  Other        stdio: ${NODE} ${BIN} mcp --root ${root}`);
    expect(out).toContain(
      'Details for one agent: openboard connect <claude-code|cursor|codex|gemini-cli|opencode|generic>',
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('quotes paths for the shell', async () => {
    const base = await tempDir();
    const root = path.join(base, "my team's project");
    await mkdir(root);
    const out = await connectOutput('claude-code', root);
    expect(out).toContain(`mcp --root '${base}/my team'\\''s project'\n`);
  });

  it('prints JSON and writes nothing', async () => {
    const root = await tempDir();
    const info = JSON.parse(await connectOutput(undefined, root, true));
    expect(info.root).toBe(root);
    expect(info.stdio).toEqual({ command: NODE, args: [BIN, 'mcp', '--root', root] });
    expect(info.http).toEqual({ url: 'http://127.0.0.1:4747/mcp', running: false });
    expect(Object.keys(info.agents)).toEqual([
      'claude-code',
      'cursor',
      'codex',
      'gemini-cli',
      'opencode',
      'generic',
    ]);

    const one = JSON.parse(await connectOutput('codex', root, true));
    expect(Object.keys(one.agents)).toEqual(['codex']);
    expect(await readdir(root)).toEqual([]);
  });
});
