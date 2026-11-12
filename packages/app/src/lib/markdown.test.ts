import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';
import { markdownToPlainText } from './plainText.js';

describe('markdown', () => {
  it('renders markdown and escapes raw HTML', () => {
    const html = renderMarkdown('**bold** <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });

  it('drops javascript: links and opens others in a new tab', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript');
    const html = renderMarkdown('[docs](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('never loads images from board content', () => {
    expect(renderMarkdown('![diagram](https://example.com/x.png)')).not.toContain('<img');
  });

  it('produces plain text for card previews', () => {
    expect(
      markdownToPlainText(
        '# Heading\n\n- [x] **Done** item\n- see [the doc](https://x.y) and `code`\n> quoted',
      ),
    ).toBe('Heading Done item see the doc and code quoted');
  });
});
