#!/usr/bin/env node
/**
 * `node relay.js <host> <port>`: the stdio command an agent is given. It joins
 * the agent's stdin and stdout to the harness's MCP socket byte for byte and
 * exits when either side closes. It imports nothing but Node, so it starts in
 * a few milliseconds and adds nothing to what the agent sees.
 */
import { connect } from 'node:net';

const [host = '127.0.0.1', portText = ''] = process.argv.slice(2);
const port = Number(portText);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('usage: relay <host> <port>\n');
  process.exit(2);
}

const socket = connect({ host, port });
socket.on('connect', () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on('error', (error) => {
  process.stderr.write(`openboard-evals relay: ${error.message}\n`);
  process.exit(1);
});
socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
