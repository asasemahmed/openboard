/**
 * MCP over Streamable HTTP, as a web-standard `(Request) => Response` handler.
 *
 * Every MCP session gets its own server instance (and so its own actor,
 * default board and cursors). Sessions are keyed by the `mcp-session-id`
 * header the transport hands out at initialize; DELETE ends one, and a
 * session that has been quiet for `idleTimeoutMs` is closed.
 */
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, type McpServerOptions } from './server.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const SESSION_HEADER = 'mcp-session-id';

export interface HttpHandlerOptions extends McpServerOptions {
  /** Close a session after this long without a request. Defaults to 30 minutes. */
  idleTimeoutMs?: number;
}

export interface McpHttpHandler {
  (request: Request): Promise<Response>;
  /** Open sessions. */
  readonly sessionCount: number;
  /** End every session and stop the idle timer. */
  close(): Promise<void>;
}

interface Entry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

function rpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function createHttpHandler(options: HttpHandlerOptions): McpHttpHandler {
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sessions = new Map<string, Entry>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTimerIfIdle = () => {
    if (sessions.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const drop = async (id: string) => {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    stopTimerIfIdle();
    await entry.server.close().catch(() => {});
  };

  const sweep = () => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeen >= idleMs) void drop(id);
    }
  };

  const startTimer = () => {
    if (timer !== undefined) return;
    timer = setInterval(sweep, Math.max(10, Math.min(idleMs, 60_000)));
    timer.unref?.();
  };

  const handle = async (request: Request): Promise<Response> => {
    sweep();
    const sessionId = request.headers.get(SESSION_HEADER);
    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return rpcError(404, -32001, 'Session not found; initialize a new session');
      entry.lastSeen = Date.now();
      return entry.transport.handleRequest(request);
    }

    if (request.method !== 'POST') {
      return rpcError(400, -32000, `Bad request: missing ${SESSION_HEADER} header`);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return rpcError(400, -32700, 'Parse error: the body is not JSON');
    }
    const messages = Array.isArray(body) ? body : [body];
    if (!messages.some((message) => isInitializeRequest(message))) {
      return rpcError(400, -32000, 'Bad request: no session; send initialize first');
    }

    const server = createMcpServer(options);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, lastSeen: Date.now() });
        startTimer();
      },
      onsessionclosed: (id) => {
        // The transport closes itself right after this; close the server once it has.
        setImmediate(() => void drop(id));
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined && sessions.get(id)?.transport === transport) {
        sessions.delete(id);
        stopTimerIfIdle();
      }
    };
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody: body });
  };

  // `Object.assign` would copy the getter's current value, so define it.
  return Object.defineProperties(handle, {
    sessionCount: { get: () => sessions.size, enumerable: true },
    close: {
      value: async () => {
        await Promise.all([...sessions.keys()].map(drop));
        stopTimerIfIdle();
      },
    },
  }) as McpHttpHandler;
}
