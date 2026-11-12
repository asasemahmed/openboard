import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppLocation } from '../lib/project.js';
import { captureIo, tempDir } from '../testing/helpers.js';
import { doctorCommand, runChecks } from './doctor.js';
import { initCommand } from './init.js';

async function builtApp(): Promise<AppLocation> {
  const dir = await tempDir();
  await writeFile(path.join(dir, 'index.html'), '<!doctype html>');
  return { dir, built: true };
}

describe('doctor', () => {
  it('passes for an initialized project', async () => {
    const dir = await tempDir();
    await initCommand(captureIo(dir));
    const io = captureIo(dir);
    const code = await doctorCommand(io, { root: dir, app: await builtApp() });
    expect(io.out()).toContain('ok    Node.js');
    expect(io.out()).toContain('ok    .openboard/main.board.json parses');
    expect(io.out()).toContain('warn  Server is not running');
    expect(io.out()).toContain('Everything looks good.');
    expect(code).toBe(0);
  });

  it('fails without .openboard and says how to fix it', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);
    expect(await doctorCommand(io, { root: dir, app: await builtApp() })).toBe(1);
    expect(io.out()).toContain('FAIL  No .openboard directory');
    expect(io.out()).toContain('fix: run `openboard init`');
  });

  it('names a broken board file and its first problem', async () => {
    const dir = await tempDir();
    await initCommand(captureIo(dir));
    await writeFile(path.join(dir, '.openboard/bad.board.json'), '{"schemaVersion": 1}');
    const io = captureIo(dir);
    expect(await doctorCommand(io, { root: dir, app: await builtApp() })).toBe(1);
    expect(io.out()).toMatch(/FAIL {2}\.openboard\/bad\.board\.json: board file is invalid: /);
  });

  it('checks config.json when there is one', async () => {
    const dir = await tempDir();
    await initCommand(captureIo(dir));
    const file = path.join(dir, '.openboard/config.json');
    const none = await runChecks(captureIo(dir), { root: dir, app: await builtApp() });
    expect(none.some((c) => c.label.includes('config.json'))).toBe(false);

    await writeFile(
      file,
      JSON.stringify({ version: 1, policy: { default: 'review_all', agents: { bot: 'locked' } } }),
    );
    const good = await runChecks(captureIo(dir), { root: dir, app: await builtApp() });
    expect(good.find((c) => c.label.includes('config.json'))).toEqual({
      status: 'ok',
      label:
        '.openboard/config.json parses (agents default to review_all; 1 agent has its own mode)',
    });

    await writeFile(file, '{"version": 1, "policy": {"default": "sometimes", "agents": {}}}');
    const io = captureIo(dir);
    expect(await doctorCommand(io, { root: dir, app: await builtApp() })).toBe(1);
    expect(io.out()).toMatch(/FAIL {2}\.openboard\/config\.json: config file is invalid: /);
    expect(io.out()).toContain('remove it to use the default policy');
  });

  it('fails for an old Node.js and an unbuilt app', async () => {
    const dir = await tempDir();
    await initCommand(captureIo(dir));
    const checks = await runChecks(captureIo(dir), {
      root: dir,
      nodeVersion: '20.11.0',
      app: { dir: '/nowhere/dist', built: false },
    });
    const failed = checks.filter((c) => c.status === 'fail').map((c) => c.label);
    expect(failed).toEqual(['Node.js 20.11.0 is too old', 'Web app is not built (/nowhere/dist)']);
  });

  it('checks that .openboard/.local is ignored inside a git repository', async () => {
    const dir = await tempDir();
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
    } catch {
      return; // git is not installed here; nothing to check.
    }
    await mkdir(path.join(dir, '.openboard/.local'), { recursive: true });
    const before = await runChecks(captureIo(dir), { root: dir, app: await builtApp() });
    expect(before.find((c) => c.label.includes('not ignored by git'))?.status).toBe('fail');

    await initCommand(captureIo(dir));
    const after = await runChecks(captureIo(dir), { root: dir, app: await builtApp() });
    expect(after.find((c) => c.label.includes('ignored by git'))?.status).toBe('ok');
  });

  it('prints JSON with --json', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);
    await doctorCommand(io, { root: dir, json: true, app: await builtApp() });
    const report = JSON.parse(io.out());
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ status: 'ok' });
  });
});
