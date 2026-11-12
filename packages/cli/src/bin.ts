#!/usr/bin/env node
// `openboard hook` runs on every tool call of an agent: load only what it
// needs, before the command line parser and the rest of the CLI.
const args = process.argv.slice(2);
if (args[0] === 'hook' && !args.includes('--help') && !args.includes('-h')) {
  const { runHook } = await import('./hook.js');
  await runHook(args.slice(1), { stdin: process.stdin, env: process.env, cwd: process.cwd() });
  process.exit(0);
}

const { processIo } = await import('./lib/io.js');
const { run } = await import('./program.js');
const code = await run(args, processIo());
process.exitCode = code;
// Exit once output has drained even if a library left a handle open. The
// timer is unref'd, so a clean exit never waits for it.
setTimeout(() => process.exit(code), 1000).unref();
