import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../testing/helpers.js';
import {
  nameFromFileName,
  parseTemplateSource,
  readTemplateSource,
  type TemplateSource,
} from './template-source.js';

const url = (u: string): TemplateSource => ({ kind: 'url', url: u, fileName: 'x.board.json' });

/** A fetch that answers each URL from the table, and records what was asked. */
function fakeFetch(answers: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    calls.push({ url: u, init });
    const answer = answers[u];
    if (!answer) throw new TypeError('fetch failed', { cause: new Error('not in the table') });
    return answer();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const redirect = (to: string, status = 302) =>
  new Response(null, { status, headers: { location: to } });

describe('parseTemplateSource', () => {
  it('turns github: sources into raw.githubusercontent.com URLs, at HEAD unless a ref is given', () => {
    expect(parseTemplateSource('github:ada/boards/templates/retro.board.json', '/w')).toEqual({
      kind: 'url',
      url: 'https://raw.githubusercontent.com/ada/boards/HEAD/templates/retro.board.json',
      fileName: 'retro.board.json',
    });
    expect(parseTemplateSource('github:ada/boards/retro.board.json@v1.2', '/w')).toMatchObject({
      url: 'https://raw.githubusercontent.com/ada/boards/v1.2/retro.board.json',
    });
    expect(
      parseTemplateSource('github:ada/boards/a b/retro.board.json@feature/next', '/w'),
    ).toMatchObject({
      url: 'https://raw.githubusercontent.com/ada/boards/feature/next/a%20b/retro.board.json',
    });
  });

  it('refuses github: sources that are incomplete or step out of the repository', () => {
    for (const bad of [
      'github:ada/boards',
      'github:ada',
      'github:ada/boards/',
      'github:ada/boards/../other/x.board.json',
      'github:ada/boards/./x.board.json',
      'github:-ada/boards/x.board.json',
      'github:ada/../x.board.json',
      'github:ada/boards/x.board.json@',
      'github:ada/boards/x.board.json@../main',
      'github:ada/boards/x.board.json@a b',
    ]) {
      expect(() => parseTemplateSource(bad, '/w'), bad).toThrow(/^github:/);
    }
  });

  it('takes https URLs, refuses other schemes, and resolves anything else as a local path', () => {
    expect(parseTemplateSource('https://example.com/t/plan.board.json?x=1', '/w')).toEqual({
      kind: 'url',
      url: 'https://example.com/t/plan.board.json?x=1',
      fileName: 'plan.board.json',
    });
    expect(() => parseTemplateSource('http://example.com/plan.board.json', '/w')).toThrow(
      'http://example.com/plan.board.json: only https:// URLs are allowed',
    );
    expect(() => parseTemplateSource('file:///etc/passwd', '/w')).toThrow(/only https/);
    expect(parseTemplateSource('../shared/plan.board.json', '/w/project')).toEqual({
      kind: 'file',
      path: path.resolve('/w/shared/plan.board.json'),
      fileName: 'plan.board.json',
    });
  });

  it('suggests a name from the file name', () => {
    expect(nameFromFileName('retro.board.json')).toBe('retro');
    expect(nameFromFileName('retro.json')).toBe('retro');
    expect(nameFromFileName('Retro.txt')).toBe('Retro.txt');
  });
});

describe('readTemplateSource', () => {
  it('downloads with redirect: manual and follows https redirects', async () => {
    const { fetch, calls } = fakeFetch({
      'https://a.example/t.board.json': () => redirect('/moved.board.json', 301),
      'https://a.example/moved.board.json': () => redirect('https://b.example/t.board.json'),
      'https://b.example/t.board.json': () => new Response('{"ok":true}'),
    });
    const bytes = await readTemplateSource(url('https://a.example/t.board.json'), { fetch });
    expect(Buffer.from(bytes).toString()).toBe('{"ok":true}');
    expect(calls.map((c) => c.url)).toEqual([
      'https://a.example/t.board.json',
      'https://a.example/moved.board.json',
      'https://b.example/t.board.json',
    ]);
    expect(calls.every((c) => c.init?.redirect === 'manual' && c.init.signal)).toBe(true);
  });

  it('refuses a redirect to http, and too many redirects', async () => {
    const { fetch, calls } = fakeFetch({
      'https://a.example/t.board.json': () => redirect('http://a.example/t.board.json'),
      'http://a.example/t.board.json': () => new Response('{}'),
    });
    await expect(
      readTemplateSource(url('https://a.example/t.board.json'), { fetch }),
    ).rejects.toThrow(
      'https://a.example/t.board.json redirected to http://a.example/t.board.json; only https:// is allowed',
    );
    expect(calls).toHaveLength(1);

    const loop = fakeFetch({ 'https://a.example/loop': () => redirect('/loop') });
    await expect(
      readTemplateSource(url('https://a.example/loop'), { fetch: loop.fetch }),
    ).rejects.toThrow('https://a.example/loop: more than 5 redirects');
  });

  it('says what the server answered when it is not a success', async () => {
    const { fetch } = fakeFetch({
      'https://a.example/t': () => new Response('nope', { status: 404, statusText: 'Not Found' }),
    });
    await expect(readTemplateSource(url('https://a.example/t'), { fetch })).rejects.toThrow(
      'https://a.example/t answered 404 Not Found',
    );
  });

  it('refuses oversize content by its declared length and while reading it', async () => {
    const big = 'x'.repeat(2000);
    const declared = fakeFetch({
      'https://a.example/t': () => new Response(big, { headers: { 'content-length': '2000' } }),
    });
    await expect(
      readTemplateSource(url('https://a.example/t'), { fetch: declared.fetch, maxBytes: 1000 }),
    ).rejects.toThrow('https://a.example/t is larger than 1000 bytes; a template must be smaller');

    // No declared length: a stream that would never end is cut off at the cap.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(300));
      },
    });
    const streamed = fakeFetch({ 'https://a.example/s': () => new Response(endless) });
    await expect(
      readTemplateSource(url('https://a.example/s'), { fetch: streamed.fetch, maxBytes: 1000 }),
    ).rejects.toThrow('is larger than 1000 bytes');
    expect(pulled).toBeLessThan(10);

    const fits = fakeFetch({ 'https://a.example/f': () => new Response('x'.repeat(1000)) });
    const bytes = await readTemplateSource(url('https://a.example/f'), {
      fetch: fits.fetch,
      maxBytes: 1000,
    });
    expect(bytes.byteLength).toBe(1000);
  });

  it('gives up after the timeout', async () => {
    const hang = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    await expect(
      readTemplateSource(url('https://a.example/t'), { fetch: hang, timeoutMs: 20 }),
    ).rejects.toThrow('https://a.example/t: no answer within 0.02 s');
  });

  it('reports a network failure in one line', async () => {
    const { fetch } = fakeFetch({});
    await expect(readTemplateSource(url('https://a.example/t'), { fetch })).rejects.toThrow(
      'https://a.example/t: download failed: not in the table',
    );
  });

  it('reads local files up to the cap', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.board.json');
    await writeFile(file, 'x'.repeat(1001));
    const source: TemplateSource = { kind: 'file', path: file, fileName: 'a.board.json' };
    await expect(readTemplateSource(source, { maxBytes: 1000 })).rejects.toThrow(
      `${file} is larger than 1000 bytes`,
    );
    expect((await readTemplateSource(source, { maxBytes: 1001 })).byteLength).toBe(1001);
    await expect(
      readTemplateSource({ ...source, path: path.join(dir, 'none.board.json') }),
    ).rejects.toThrow('no such file:');
    await expect(readTemplateSource({ ...source, path: dir })).rejects.toThrow(
      /is a folder|not a file/,
    );
  });
});
