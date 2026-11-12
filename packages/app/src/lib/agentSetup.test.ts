import { describe, expect, it } from 'vitest';
import {
  claudeCodeCommand,
  codexToml,
  examplePrompts,
  mcpServersJson,
  shellQuote,
  snippetsFor,
  tomlString,
} from './agentSetup.js';
import { parseServerInfo } from './api.js';

const simple = {
  httpUrl: 'http://127.0.0.1:4747/mcp',
  stdio: { command: 'npx', args: ['openboard', 'mcp', '--root', '/work/shop'] },
};
const spaced = {
  httpUrl: 'http://127.0.0.1:4747/mcp',
  stdio: {
    command: '/Users/ada/My Tools/node',
    args: ['/Users/ada/My Projects/open board/cli.js', 'mcp', "--name=Ada's board"],
  },
};

describe('shellQuote', () => {
  it('leaves plain words alone and quotes the rest', () => {
    expect(shellQuote('openboard')).toBe('openboard');
    expect(shellQuote('/work/shop')).toBe('/work/shop');
    expect(shellQuote('--root=/a')).toBe('--root=/a');
    expect(shellQuote('My Projects')).toBe("'My Projects'");
    expect(shellQuote("Ada's")).toBe("'Ada'\\''s'");
    expect(shellQuote('$HOME')).toBe("'$HOME'");
    expect(shellQuote('')).toBe("''");
  });
});

describe('Claude Code', () => {
  it('builds the claude mcp add command', () => {
    expect(claudeCodeCommand(simple)).toBe(
      'claude mcp add openboard -- npx openboard mcp --root /work/shop',
    );
  });

  it('quotes paths with spaces and quotes', () => {
    expect(claudeCodeCommand(spaced)).toBe(
      "claude mcp add openboard -- '/Users/ada/My Tools/node' '/Users/ada/My Projects/open board/cli.js' mcp '--name=Ada'\\''s board'",
    );
  });

  it('offers the command and the .mcp.json block', () => {
    const snippets = snippetsFor('claude', spaced);
    expect(snippets.map((s) => s.file)).toEqual([undefined, '.mcp.json']);
    expect(JSON.parse(snippets[1]?.text ?? '')).toEqual({
      mcpServers: { openboard: { command: spaced.stdio.command, args: spaced.stdio.args } },
    });
  });
});

describe('Cursor', () => {
  it('uses the mcpServers block in .cursor/mcp.json', () => {
    const [snippet] = snippetsFor('cursor', simple);
    expect(snippet?.file).toBe('.cursor/mcp.json');
    expect(snippet?.text).toBe(mcpServersJson(simple));
    expect(JSON.parse(snippet?.text ?? '').mcpServers.openboard.args).toEqual(simple.stdio.args);
  });
});

describe('Codex', () => {
  it('writes a TOML table with command and args', () => {
    expect(codexToml(simple)).toBe(
      [
        '[mcp_servers.openboard]',
        'command = "npx"',
        'args = ["openboard", "mcp", "--root", "/work/shop"]',
      ].join('\n'),
    );
  });

  it('escapes TOML strings', () => {
    expect(tomlString('C:\\Program Files\\node.exe')).toBe('"C:\\\\Program Files\\\\node.exe"');
    expect(tomlString('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
    expect(codexToml(spaced)).toContain('command = "/Users/ada/My Tools/node"');
    expect(codexToml(spaced)).toContain(`"--name=Ada's board"`);
  });
});

describe('Other', () => {
  it('shows the stdio command and the HTTP URL', () => {
    expect(snippetsFor('other', spaced).map((s) => s.text)).toEqual([
      "'/Users/ada/My Tools/node' '/Users/ada/My Projects/open board/cli.js' mcp '--name=Ada'\\''s board'",
      'http://127.0.0.1:4747/mcp',
    ]);
  });
});

describe('examplePrompts', () => {
  it('names the board in every prompt', () => {
    const prompts = examplePrompts('Checkout');
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) expect(prompt.text).toContain('“Checkout”');
  });
});

describe('parseServerInfo', () => {
  it('keeps a well-formed mcp block', () => {
    const info = parseServerInfo({
      version: '1.0.0',
      root: '/work/shop',
      projectName: 'shop',
      url: 'http://127.0.0.1:4747',
      mcp: simple,
    });
    expect(info?.mcp).toEqual(simple);
  });

  it('drops a malformed mcp block and rejects non-objects', () => {
    expect(
      parseServerInfo({ version: '1', mcp: { httpUrl: 'x', stdio: { command: 'npx' } } }),
    ).toMatchObject({ version: '1' });
    expect(parseServerInfo({ mcp: { httpUrl: 'x', stdio: { command: 'npx' } } })?.mcp).toBe(
      undefined,
    );
    expect(parseServerInfo('nope')).toBeNull();
    expect(parseServerInfo(null)).toBeNull();
  });
});
