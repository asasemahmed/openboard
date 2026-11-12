/**
 * Serves the built web app. Hashed build assets are cached for a year; every
 * other path that is not a file gets `index.html`, because the app routes on
 * the client (`/b/<boardId>`).
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/** Vite names build output like `index-BkX2a9fQ.js`; such a name changes whenever its content does. */
const HASHED = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

export interface StaticFile {
  body: Uint8Array<ArrayBuffer>;
  headers: Record<string, string>;
}

async function fileAt(file: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    if (!(await stat(file)).isFile()) return null;
    return new Uint8Array(await readFile(file));
  } catch {
    return null;
  }
}

function headersFor(file: string, relative: string): Record<string, string> {
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const immutable = relative.startsWith('assets/') && HASHED.test(relative);
  return {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };
}

/** The file for a request path, or `index.html` when there is none. Null when the app has no index. */
export async function resolveStatic(appDir: string, pathname: string): Promise<StaticFile | null> {
  const root = path.resolve(appDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = '/';
  }
  const relative = path.posix.normalize(decoded).replace(/^\/+/, '');
  const candidate = path.resolve(root, relative);
  // Never serve anything outside the app directory.
  if (relative !== '' && !relative.includes('\0') && candidate.startsWith(root + path.sep)) {
    const body = await fileAt(candidate);
    if (body) return { body, headers: headersFor(candidate, relative) };
  }
  const index = path.join(root, 'index.html');
  const body = await fileAt(index);
  return body ? { body, headers: headersFor(index, 'index.html') } : null;
}
