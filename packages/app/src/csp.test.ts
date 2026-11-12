/** The Content-Security-Policy in index.html: present, strict, and not weakened by accident. */
import { describe, expect, it } from 'vitest';
import html from '../index.html?raw';
import theme from '../public/theme.js?raw';

function policy(): Map<string, string[]> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const content = meta?.getAttribute('content') ?? '';
  return new Map(
    content
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name = '', ...values]) => [name, values]),
  );
}

describe('Content-Security-Policy', () => {
  const csp = policy();

  it('locks down everything by default', () => {
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.get('frame-src')).toEqual(["'none'"]);
    expect(csp.get('worker-src')).toEqual(["'none'"]);
  });

  it('runs only its own scripts: no inline code, no eval', () => {
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
    for (const values of csp.values()) expect(values).not.toContain("'unsafe-eval'");
  });

  it('allows inline styles in attributes only (the canvas positions nodes with them)', () => {
    expect(csp.get('style-src-elem')).toEqual(["'self'"]);
    expect(csp.get('style-src-attr')).toEqual(["'unsafe-inline'"]);
  });

  it('allows what the app needs and no more', () => {
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(csp.get('connect-src')).toEqual(["'self'", 'ws:', 'wss:']);
    expect(csp.get('font-src')).toEqual(["'self'"]);
  });

  it('applies the saved theme from a file, not an inline script', () => {
    expect(html).toContain('<script src="/theme.js"></script>');
    expect(theme).toContain('openboard.theme');
  });
});
