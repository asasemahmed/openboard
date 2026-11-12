/**
 * Opening a linked file in the person's editor: absolute paths from the
 * project root and a link's target, and editor URLs for the schemes editors
 * register (`vscode://file/<path>:<line>` and friends). Pure functions; the
 * chosen scheme is a per-browser preference.
 */
import { isString, readStored, writeStored } from './storage.js';

export type EditorScheme = 'vscode' | 'cursor' | 'zed' | 'copy';

export const EDITORS: ReadonlyArray<{ id: EditorScheme; name: string }> = [
  { id: 'vscode', name: 'VS Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'zed', name: 'Zed' },
  { id: 'copy', name: 'Copy the path' },
];

const KEY = 'editor';
const isScheme = (v: unknown): v is EditorScheme => isString(v) && EDITORS.some((e) => e.id === v);

export function readEditorScheme(): EditorScheme {
  return readStored(KEY, isScheme) ?? 'vscode';
}

export function writeEditorScheme(scheme: EditorScheme): void {
  writeStored(KEY, scheme);
}

/** A Windows path such as `C:\\work` or `C:/work`. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * The file part of a target. A `symbol` link's target is `path#symbol`; a
 * `file` link's target is all path, `#` included.
 */
export function filePart(target: string, kind: 'file' | 'symbol' = 'file'): string {
  if (kind === 'file') return target;
  const hash = target.indexOf('#');
  return hash < 0 ? target : target.slice(0, hash);
}

/**
 * The absolute path of a project-relative target, with forward slashes.
 * Null when the target is not inside the project (absolute, or climbing out
 * with `..`), so nothing outside it is ever opened.
 */
export function absolutePath(
  root: string,
  target: string,
  kind: 'file' | 'symbol' = 'file',
): string | null {
  const file = filePart(target, kind).trim().replace(/\\/g, '/');
  if (
    !file ||
    file.startsWith('/') ||
    WINDOWS_DRIVE.test(file) ||
    /^[a-z][a-z0-9+.-]*:/i.test(file)
  )
    return null;
  const parts: string[] = [];
  for (const part of file.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${base}/${parts.join('/')}`;
}

/** Percent-encode a path for a URL, keeping `/` and the drive colon readable. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment, i) =>
      i <= 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join('/');
}

/**
 * The URL that opens `target` (at `line`) in the editor, or null for "copy
 * the path" and for targets outside the project. Windows paths get a leading
 * slash (`vscode://file/C:/work/a.ts`), as the editors expect.
 */
export function editorUrl(
  scheme: EditorScheme,
  root: string,
  target: string,
  line?: number,
  kind: 'file' | 'symbol' = 'file',
): string | null {
  if (scheme === 'copy') return null;
  const abs = absolutePath(root, target, kind);
  if (!abs) return null;
  const path = encodePath(abs.startsWith('/') ? abs : `/${abs}`);
  const suffix = line && line > 0 ? `:${Math.floor(line)}` : '';
  return `${scheme}://file${path}${suffix}`;
}

/** Why a target typed for a new file link is not usable, or null when it is. */
export function linkTargetProblem(kind: 'file' | 'symbol' | 'url', target: string): string | null {
  const value = target.trim();
  if (!value) return kind === 'url' ? 'Enter an address.' : 'Enter a path.';
  if (kind === 'url') {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return 'Use an http or https address.';
      return null;
    } catch {
      return 'That is not a full address. Include https://';
    }
  }
  const file = filePart(value, kind).replace(/\\/g, '/');
  if (file.startsWith('/') || WINDOWS_DRIVE.test(file) || file.startsWith('~'))
    return 'Use a path relative to the project root, like src/payments/retry.ts.';
  if (file.split('/').includes('..'))
    return 'The path climbs out of the project; links stay inside it.';
  if (kind === 'symbol' && !value.includes('#'))
    return 'Name the symbol after a #, like src/api.ts#createUser.';
  if (!file) return 'Enter the file the symbol is in, like src/api.ts#createUser.';
  return null;
}

/** "3", "3–5": a line range for people. */
export function lineRange(line?: number, endLine?: number): string {
  if (!line) return '';
  return endLine && endLine !== line ? `${line}–${endLine}` : `${line}`;
}

/** An address that is safe to open from board content: http or https only. */
export function safeHttpUrl(target: string): string | null {
  try {
    const url = new URL(target);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
