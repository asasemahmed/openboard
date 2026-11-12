/**
 * The MCP endpoint an agent connects to: the real OpenBoard MCP server
 * (`createMcpServer`), one instance per connection, behind the recording
 * proxy. It is reachable three ways, all recorded the same:
 *
 * - `stdio`: a command (the relay) that pipes the agent's stdio to a socket;
 * - `url`: Streamable HTTP on loopback;
 * - `tcp`: the socket itself, for in-process runners.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, type McpServerOptions } from '@openboard/mcp';
import type { Recorder } from './trace.js';
import { StreamTransport } from './transport.js';

export interface EndpointOptions {
  recorder: Recorder;
  resolveApi: McpServerOptions['resolveApi'];
  defaultBoard?: string;
}

export interface Endpoint {
  tcp: { host: string; port: number };
  /** Streamable HTTP. */
  url: string;
  /** The command an agent runs to reach the board over stdio. */
  stdio: { command: string; args: string[] };
  close(): Promise<void>;
}

const HOST = '127.0.0.1';

/** How to start the relay: the built script, or the source under Node's type stripping. */
export function relayCommand(host: string, port: number): { command: string; args: string[] } {
  const built = fileURLToPath(new URL('./relay.js', import.meta.url));
  if (existsSync(built)) return { command: process.execPath, args: [built, host, String(port)] };
  const source = fileURLToPath(new URL('./relay.ts', import.meta.url));
  return {
    command: process.execPath,
    args: ['--experimental-strip-types', '--no-warnings', source, host, String(port)],
  };
}

function listen(server: Server | TcpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

export async function startEndpoint(options: EndpointOptions): Promise<Endpoint> {
  const servers = new Set<McpServer>();
  const sockets = new Set<Socket>();
  const serve = (session?: () => string | undefined) => {
    const server = createMcpServer({
      resolveApi: options.resolveApi,
      ...(options.defaultBoard !== undefined ? { defaultBoard: options.defaultBoard } : {}),
      ...(session ? { session } : {}),
    });
    servers.add(server);
    return server;
  };

  const tcp = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const server = serve();
    void server.connect(options.recorder.wrap(new StreamTransport(socket)));
    socket.on('close', () => {
      servers.delete(server);
      void server.close().catch(() => {});
    });
  });
  const tcpPort = await listen(tcp);

  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http = createHttpServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${HOST}`);
      if (url.pathname !== '/mcp') {
        response.writeHead(404).end();
        return;
      }
      const sessionId = request.headers['mcp-session-id'];
      if (typeof sessionId === 'string') {
        const transport = sessions.get(sessionId);
        if (!transport) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null,
            }),
          );
          return;
        }
        await transport.handleRequest(request, response);
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(400).end();
        return;
      }
      const body = await readBody(request);
      const messages = Array.isArray(body) ? body : [body];
      if (!messages.some((message) => isInitializeRequest(message))) {
        response.writeHead(400).end();
        return;
      }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const server = serve(() => transport.sessionId);
      await server.connect(options.recorder.wrap(transport));
      await transport.handleRequest(request, response, body);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const httpPort = await listen(http);

  let closing: Promise<void> | undefined;
  return {
    tcp: { host: HOST, port: tcpPort },
    url: `http://${HOST}:${httpPort}/mcp`,
    stdio: relayCommand(HOST, tcpPort),
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await Promise.all([...servers].map((server) => server.close().catch(() => {})));
        await Promise.all(
          [...sessions.values()].map((transport) => transport.close().catch(() => {})),
        );
        await new Promise<void>((resolve) => tcp.close(() => resolve()));
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}
