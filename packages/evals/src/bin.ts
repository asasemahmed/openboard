#!/usr/bin/env node
import { main } from './cli.js';

// Ctrl-C: the first one stops the running agents and cleans up; a second one exits at once.
const controller = new AbortController();
process.on('SIGINT', () => {
  if (controller.signal.aborted) process.exit(130);
  process.stderr.write(
    '\nStopping: ending the agent runs and cleaning up (Ctrl-C again to quit now)...\n',
  );
  controller.abort();
});
process.on('SIGTERM', () => controller.abort());

const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  signal: controller.signal,
});
process.exitCode = code;
// Exit once output has drained even if a library left a handle open.
setTimeout(() => process.exit(code), 1000).unref();
