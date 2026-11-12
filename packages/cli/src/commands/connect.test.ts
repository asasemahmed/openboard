import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
    expect(out).toContain(`  Other        stdio: ${NODE} ${BIN} mcp --root ${root}`);
    expect(out).toContain(
      'Details for one agent: openboard connect <claude-code|cursor|codex|generic>',
    );
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
    expect(Object.keys(info.agents)).toEqual(['claude-code', 'cursor', 'codex', 'generic']);

    const one = JSON.parse(await connectOutput('codex', root, true));
    expect(Object.keys(one.agents)).toEqual(['codex']);
    expect(await readdir(root)).toEqual([]);
  });
});
