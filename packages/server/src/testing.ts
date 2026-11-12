/**
 * Helpers for the server's own tests: throwaway project roots, a server on an
 * ephemeral port, and raw HTTP requests (raw because `fetch` will not let a
 * test send its own `Host` header).
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';
import type { OpenBoardServer, ServerOptions } from './types.js';

export async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), 'openboard-test-')));
}

export async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export function startTestServer(
  root: string,
  options: Omit<ServerOptions, 'root'> = {},
): Promise<OpenBoardServer> {
  return startServer({
    port: 0,
    log: process.env.OPENBOARD_TEST_LOG ? (l) => console.log(l) : undefined,
    ...options,
    root,
  });
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  // `any`: tests inspect response bodies loosely, field by field.
  json: any;
}

/** One HTTP request with full control over headers, including `Host`. */
export function rawRequest(
  url: string,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  const target = new URL(opts.path ?? '/', url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: opts.method ?? 'GET',
        // A fresh connection each time: a reused one may be the one the server just closed.
        agent: false,
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('error', reject);
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** POST/GET JSON to the server's API. */
export function api(
  server: OpenBoardServer,
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return rawRequest(server.url, {
    method,
    path: pathname,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Poll until `check` returns a truthy value, or fail after `timeoutMs`. */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeoutMs = 5000, intervalMs = 20, what = 'condition' } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
