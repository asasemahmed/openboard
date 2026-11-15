/**
 * Where `openboard template add` reads a template from: a file on GitHub
 * (`github:owner/repo/path[@ref]`), an https URL, or a local file. Downloads
 * are https only, redirects included, with a timeout and a size cap that is
 * enforced while reading, so a large or slow answer never fills memory.
 */
import { open } from 'node:fs/promises';
import path from 'node:path';
import { CliError, isNodeError } from './errors.js';

/** Templates larger than this are refused, wherever they come from. */
export const MAX_ADD_BYTES = 1024 * 1024;
/** A download, redirects included, must finish within this. */
export const ADD_TIMEOUT_MS = 20_000;
/** At most this many redirects are followed. */
export const MAX_REDIRECTS = 5;

export type TemplateSource =
  | { kind: 'url'; url: string; fileName: string }
  | { kind: 'file'; path: string; fileName: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;

function badSegment(segment: string): boolean {
  return segment === '' || segment === '.' || segment === '..' || segment.includes('\\');
}

/** `github:owner/repo/path/to/file.board.json[@ref]` as a raw.githubusercontent.com URL. */
function parseGithub(spec: string, source: string): TemplateSource {
  const usage = `${source}: expected github:owner/repo/path/to/file.board.json, optionally ending in @ref`;
  let rest = spec;
  let ref = 'HEAD';
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    ref = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!REF.test(ref) || ref.split('/').some(badSegment)) {
      throw new CliError(`${source}: "${ref}" is not a valid git ref`);
    }
  }
  const [owner, repo, ...file] = rest.split('/');
  if (owner === undefined || repo === undefined || file.length === 0) throw new CliError(usage);
  if (!OWNER.test(owner)) throw new CliError(`${source}: "${owner}" is not a GitHub owner`);
  if (!REPO.test(repo) || repo === '.' || repo === '..') {
    throw new CliError(`${source}: "${repo}" is not a GitHub repository`);
  }
  if (file.some(badSegment)) throw new CliError(usage);
  const parts = [owner, repo, ...ref.split('/'), ...file].map(encodeURIComponent);
  return {
    kind: 'url',
    url: `https://raw.githubusercontent.com/${parts.join('/')}`,
    fileName: file[file.length - 1] as string,
  };
}

/** Parse a source argument. Local paths are resolved against `cwd`. */
export function parseTemplateSource(source: string, cwd: string): TemplateSource {
  if (source.startsWith('github:')) return parseGithub(source.slice('github:'.length), source);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new CliError(`${source}: not a valid URL`);
    }
    if (url.protocol !== 'https:') {
      throw new CliError(`${source}: only https:// URLs are allowed`);
    }
    const last = url.pathname.split('/').pop() ?? '';
    let fileName = last;
    try {
      fileName = decodeURIComponent(last);
    } catch {
      // Keep it as written; the name check reports it.
    }
    return { kind: 'url', url: url.href, fileName };
  }
  const file = path.resolve(cwd, source);
  return { kind: 'file', path: file, fileName: path.basename(file) };
}

/** The template id a file name suggests: `retro.board.json` and `retro.json` give `retro`. */
export function nameFromFileName(fileName: string): string {
  return fileName.replace(/\.board\.json$/i, '').replace(/\.json$/i, '');
}

export interface ReadOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

const tooLarge = (what: string, max: number) =>
  new CliError(`${what} is larger than ${max} bytes; a template must be smaller`);

/** The bytes of a template source, or a CliError saying in one line why not. */
export async function readTemplateSource(
  source: TemplateSource,
  options: ReadOptions = {},
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? MAX_ADD_BYTES;
  if (source.kind === 'file') return readLocal(source.path, maxBytes);
  return download(source.url, { ...options, maxBytes });
}

async function readLocal(file: string, maxBytes: number): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') throw new CliError(`no such file: ${file}`);
    if (isNodeError(error) && error.code === 'EISDIR') throw new CliError(`${file} is a folder`);
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new CliError(`${file} is not a file`);
    // Read one byte more than allowed, so a file that grew is caught too.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw tooLarge(file, maxBytes);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function download(
  start: string,
  options: ReadOptions & { maxBytes: number },
): Promise<Uint8Array> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? ADD_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let url = start;
  try {
    for (let hop = 0; ; hop++) {
      const response = await fetchFn(url, {
        redirect: 'manual',
        signal,
        headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) throw new CliError(`${url} redirected without a location`);
        if (hop >= MAX_REDIRECTS)
          throw new CliError(`${start}: more than ${MAX_REDIRECTS} redirects`);
        const next = new URL(location, url);
        if (next.protocol !== 'https:') {
          throw new CliError(`${url} redirected to ${next.href}; only https:// is allowed`);
        }
        url = next.href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const text = `${response.status} ${response.statusText}`.trim();
        throw new CliError(`${url} answered ${text}`);
      }
      return await readCapped(response, url, options.maxBytes);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (signal.aborted) throw new CliError(`${start}: no answer within ${timeoutMs / 1000} s`);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    const reason = cause?.message ?? (error instanceof Error ? error.message : String(error));
    throw new CliError(`${url}: download failed: ${reason}`);
  }
}

async function readCapped(response: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge(url, maxBytes);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(url, maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}
