/**
 * MCP over a byte stream, framed as newline-delimited JSON exactly like stdio.
 * The harness serves the board on a local TCP port with this framing, and the
 * relay (`relay.ts`) turns an agent's stdio into that socket byte for byte, so
 * what the agent sends is what the board server receives.
 */
import type { Duplex } from 'node:stream';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export class StreamTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #stream: Duplex;
  readonly #buffer = new ReadBuffer();
  #closed = false;

  constructor(stream: Duplex) {
    this.#stream = stream;
  }

  async start(): Promise<void> {
    this.#stream.on('data', (chunk: Buffer) => {
      this.#buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.#buffer.readMessage();
        } catch (error) {
          this.onerror?.(error as Error);
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    this.#stream.on('error', (error: Error) => this.onerror?.(error));
    this.#stream.on('close', () => this.#finish());
    this.#stream.on('end', () => this.#finish());
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (this.#closed || this.#stream.destroyed) return resolve();
      this.#stream.write(serializeMessage(message), () => resolve());
    });
  }

  async close(): Promise<void> {
    this.#stream.end();
    this.#stream.destroy();
    this.#finish();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer.clear();
    this.onclose?.();
  }
}
