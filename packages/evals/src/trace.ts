/**
 * The recording proxy. Every MCP connection an agent opens is wrapped in a
 * `RecordingTransport` before the real OpenBoard MCP server sees it, so the
 * harness records each tool call exactly as it crossed the wire: name,
 * arguments, the text the agent got back, whether it was an error, how long it
 * took, and the estimated tokens either way. The trace is the ground truth for
 * cost and behaviour.
 *
 * The proxy can also hold a tool call back (`beforeCall`) until the simulated
 * person has finished reacting to the previous one, so "edit a node after the
 * agent's first read" happens in that order however fast the agent is.
 */
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { estimateTokens } from '@openboard/core';
import type { ToolCallRecord, Trace } from './types.js';

export interface RecorderHooks {
  /** Awaited before a tool call is passed on to the board. */
  beforeCall?: (tool: string) => Promise<void>;
  /** Called once a tool call has been answered, before the agent can read the answer. */
  afterCall?: (record: ToolCallRecord) => void;
}

type Id = string | number;

interface Pending {
  tool: string;
  args: Record<string, unknown>;
  startedMs: number;
}

export function emptyTrace(): Trace {
  return { calls: [], connections: 0, clients: [], toolListRequests: 0, otherRequests: {} };
}

/** The text of a `tools/call` result: every text item, joined by newlines. */
export function resultText(result: unknown): { text: string; isError: boolean } {
  const value = (result ?? {}) as { content?: unknown; isError?: unknown };
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('\n');
  return { text, isError: value.isError === true };
}

export class Recorder {
  readonly trace: Trace = emptyTrace();
  readonly #started: number;
  readonly #now: () => number;
  hooks: RecorderHooks;

  constructor(options: { now?: () => number; hooks?: RecorderHooks } = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#started = this.#now();
    this.hooks = options.hooks ?? {};
  }

  /** Milliseconds since the recorder was made. */
  elapsed(): number {
    return this.#now() - this.#started;
  }

  /** Wrap one connection's transport; give the result to the MCP server. */
  wrap(inner: Transport): Transport {
    this.trace.connections++;
    return new RecordingTransport(inner, this, this.trace.connections);
  }

  /** @internal */
  record(connection: number, pending: Pending, result: { text: string; isError: boolean }): void {
    const record: ToolCallRecord = {
      seq: this.trace.calls.length + 1,
      connection,
      tool: pending.tool,
      args: pending.args,
      text: result.text,
      isError: result.isError,
      startedMs: Math.round(pending.startedMs),
      durationMs: Math.round(this.elapsed() - pending.startedMs),
      argsTokens: estimateTokens(JSON.stringify(pending.args)),
      resultTokens: estimateTokens(result.text),
    };
    this.trace.calls.push(record);
    this.hooks.afterCall?.(record);
  }
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & {
  id: Id;
  method: string;
  params?: Record<string, unknown>;
} {
  return 'method' in message && 'id' in message;
}

function isResponse(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: Id; result?: unknown; error?: { message?: string } } {
  return 'id' in message && !('method' in message) && ('result' in message || 'error' in message);
}

class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];
  readonly #pending = new Map<Id, Pending>();
  /** Incoming messages pass one at a time, so holding a call back keeps their order. */
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: Transport,
    private readonly recorder: Recorder,
    private readonly connection: number,
  ) {
    const setProtocolVersion = (inner as { setProtocolVersion?: (version: string) => void })
      .setProtocolVersion;
    if (setProtocolVersion) {
      (this as { setProtocolVersion?: (version: string) => void }).setProtocolVersion = (
        version: string,
      ) => setProtocolVersion.call(inner, version);
    }
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => {
      this.#queue = this.#queue
        .then(() => this.#receive(message))
        .then(
          () => this.onmessage?.(message, extra),
          (error: unknown) => this.onerror?.(error as Error),
        );
    };
    await this.inner.start();
  }

  async #receive(message: JSONRPCMessage): Promise<void> {
    if (!isRequest(message)) return;
    const trace = this.recorder.trace;
    switch (message.method) {
      case 'initialize': {
        const info = (message.params?.clientInfo ?? {}) as { name?: unknown; version?: unknown };
        trace.clients.push({
          name: typeof info.name === 'string' ? info.name : '',
          ...(typeof info.version === 'string' ? { version: info.version } : {}),
        });
        return;
      }
      case 'tools/list':
        trace.toolListRequests++;
        return;
      case 'tools/call': {
        const params = message.params ?? {};
        const tool = typeof params.name === 'string' ? params.name : '';
        const args =
          typeof params.arguments === 'object' && params.arguments !== null
            ? (params.arguments as Record<string, unknown>)
            : {};
        await this.recorder.hooks.beforeCall?.(tool);
        this.#pending.set(message.id, { tool, args, startedMs: this.recorder.elapsed() });
        return;
      }
      default:
        trace.otherRequests[message.method] = (trace.otherRequests[message.method] ?? 0) + 1;
    }
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (isResponse(message)) {
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        const result =
          message.error !== undefined
            ? { text: String(message.error.message ?? 'error'), isError: true }
            : resultText(message.result);
        this.recorder.record(this.connection, pending, result);
      }
    }
    await this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
