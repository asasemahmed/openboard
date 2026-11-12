/**
 * MCP over stdio. Stdout carries protocol messages only: anything else
 * written there would corrupt the stream, so logging belongs on stderr.
 */
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, type McpServerOptions } from './server.js';

export interface StdioOptions extends McpServerOptions {
  /** Defaults to `process.stdin`. */
  stdin?: Readable;
  /** Defaults to `process.stdout`. */
  stdout?: Writable;
}

/** Serve one MCP session over stdio. Resolves when the client goes away (stdin ends) or the session closes. */
export async function runStdio(options: StdioOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const server = createMcpServer(options);
  const transport = new StdioServerTransport(stdin, stdout);
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    const end = () => {
      void server.close().finally(resolve);
    };
    stdin.once('end', end);
    stdin.once('close', end);
  });
  await server.connect(transport);
  await closed;
}
