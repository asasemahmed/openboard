#!/usr/bin/env node
import { processIo } from './lib/io.js';
import { run } from './program.js';

const code = await run(process.argv.slice(2), processIo());
process.exitCode = code;
// Exit once output has drained even if a library left a handle open. The
// timer is unref'd, so a clean exit never waits for it.
setTimeout(() => process.exit(code), 1000).unref();
