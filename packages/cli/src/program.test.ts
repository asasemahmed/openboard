import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serializeBoard } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { run } from './program.js';
import { captureIo, sampleBoard, tempDir } from './testing/helpers.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

describe('argument parsing and exit codes', () => {
  it('prints help with commands and examples', async () => {
    const io = captureIo(await tempDir());
    expect(await run(['--help'], io)).toBe(0);
    for (const command of [
      'start',
      'init',
      'status',
      'stop',
      'boards',
      'new',
      'export',
      'doctor',
      'mcp',
      'connect',
      'policy',
      'proposals',
      'accept',
      'reject',
      'history',
      'undo',
    ]) {
      expect(io.out()).toContain(`  ${command} `);
    }
    expect(io.out()).toContain('Examples:');
    expect(io.err()).toBe('');
  });

  it('prints the package version', async () => {
    const io = captureIo(await tempDir());
    expect(await run(['--version'], io)).toBe(0);
    expect(io.out()).toBe(`${pkg.version}\n`);
  });

  it('runs a command and returns its exit code', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);
    expect(await run(['init'], io)).toBe(0);
    const status = captureIo(dir);
    expect(await run(['status', '--json'], status)).toBe(0);
    expect(JSON.parse(status.out()).boards).toHaveLength(1);
  });

  it('routes policy subcommands and their --root', async () => {
    const dir = await tempDir();
    const elsewhere = captureIo(await tempDir());
    expect(
      await run(['policy', 'set', 'review_all', '--agent', 'bot', '--root', dir], elsewhere),
    ).toBe(0);
    expect(elsewhere.out()).toBe('Agent bot now uses review_all.\n');
    const shown = captureIo(dir);
    expect(await run(['policy', '--root', dir, '--json'], shown)).toBe(0);
    expect(JSON.parse(shown.out()).policy.agents).toEqual({ bot: 'review_all' });
    const unset = captureIo(dir);
    expect(await run(['policy', '--root', dir, 'unset', '--agent', 'bot'], unset)).toBe(0);
    expect(unset.out()).toBe('Agent bot now uses the default, review_destructive.\n');
    const missing = captureIo(dir);
    expect(await run(['policy', 'unset'], missing)).toBe(1);
    expect(missing.err()).toBe("openboard: required option '--agent <id>' not specified\n");
  });

  it('rejects an unknown command with one line', async () => {
    const io = captureIo(await tempDir());
    expect(await run(['frobnicate'], io)).toBe(1);
    expect(io.err()).toBe('openboard: unknown command "frobnicate" (see openboard --help)\n');
    expect(io.out()).toBe('');
  });

  it('rejects an unknown option and a bad value with one line each', async () => {
    const dir = await tempDir();
    const unknown = captureIo(dir);
    expect(await run(['status', '--nope'], unknown)).toBe(1);
    expect(unknown.err()).toBe("openboard: unknown option '--nope'\n");

    const badFormat = captureIo(dir);
    expect(await run(['export', '--format', 'pdf'], badFormat)).toBe(1);
    expect(badFormat.err().trim().split('\n')).toHaveLength(1);
    expect(badFormat.err()).toContain('json, outline, text');

    const badPort = captureIo(dir);
    expect(await run(['start', '--port', 'abc', '--no-open'], badPort)).toBe(1);
    expect(badPort.err()).toContain('must be a whole number');
  });

  it('turns a failure into one line on stderr without a stack trace', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);
    expect(await run(['export', 'missing', '--root', dir], io)).toBe(1);
    expect(io.err()).toMatch(/^openboard: no board "missing" in .*\n$/);
  });

  it('adds the stack trace with OPENBOARD_DEBUG=1', async () => {
    const dir = await tempDir();
    const io = captureIo(dir, { OPENBOARD_DEBUG: '1' });
    expect(await run(['export', 'missing', '--root', dir], io)).toBe(1);
    expect(io.err().split('\n').length).toBeGreaterThan(3);
    expect(io.err()).toContain('    at ');
  });

  it('fails for a --root that does not exist', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);
    expect(await run(['boards', '--root', 'no/such/dir'], io)).toBe(1);
    expect(io.err()).toBe('openboard: --root no/such/dir: no such directory\n');
  });

  it('passes the board, format and output file to export', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, '.openboard'));
    await writeFile(path.join(dir, '.openboard/main.board.json'), serializeBoard(sampleBoard()));
    const io = captureIo(dir);
    expect(await run(['export', 'main', '-f', 'outline', '-o', 'out.txt'], io)).toBe(0);
    expect(readFileSync(path.join(dir, 'out.txt'), 'utf8')).toContain('Board main');
  });

  it('runs connect and rejects an unknown agent', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);
    expect(await run(['connect', 'cursor', '--root', dir], io)).toBe(0);
    expect(io.out()).toContain('Add this to .cursor/mcp.json:');
    const bad = captureIo(dir);
    expect(await run(['connect', 'vim'], bad)).toBe(1);
    expect(bad.err()).toBe(
      'openboard: unknown agent "vim" (choose one of: claude-code, cursor, codex, generic)\n',
    );
  });

  it('creates a board with new', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);
    expect(await run(['new', 'Ideas', '--id', 'ideas'], io)).toBe(0);
    expect(io.out()).toBe('Created board ideas\n');
    const again = captureIo(dir);
    expect(await run(['new', 'Ideas', '--id', 'ideas'], again)).toBe(1);
    expect(again.err()).toMatch(/^openboard: board "ideas" already exists/);
  });
});
