import { describe, expect, it } from 'vitest';
import { build, HOSTILE, richBoard } from './fixtures.test.js';
import { codeSpan, escapeMarkdown, toMarkdown } from './markdown.js';

describe('toMarkdown', () => {
  const md = toMarkdown(richBoard());
  const lines = md.split('\n');

  it('starts with the escaped board name and the frame description', () => {
    expect(lines[0]).toBe('# Checkout \\<plan\\> \\& "more"');
    expect(md).toContain('## Checkout\n\nEverything about paying.');
  });

  it('lists unframed nodes first, then frames as nested headings in reading order', () => {
    const firstHeading = lines.findIndex((line, i) => i > 0 && line.startsWith('#'));
    const unframed = lines.slice(1, firstHeading).join('\n');
    expect(unframed).toContain('Ship the checkout flow');
    expect(unframed).toContain('[ ] Old flow (cancelled)');
    const headings = lines.filter((line) => /^#{2,6} /.test(line));
    expect(headings).toEqual(['## Checkout', '### Payment \\[API\\] "v2"', '## Later']);
    // Inside "Checkout": positioned nodes in reading order, then the ones without a position.
    const checkout = md.slice(md.indexOf('## Checkout'), md.indexOf('### Payment'));
    const order = ['Use Stripe', 'He said', 'Use \\[x\\]', '] Write docs', '] Load test'].map((t) =>
      checkout.indexOf(t),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('renders tasks as checkboxes with their status in words, other types with a prefix', () => {
    expect(md).toContain('- [x] Payment API\n');
    expect(md).toContain('- [ ] Retry logic (in progress)');
    expect(md).toContain('- [ ] Write docs\n');
    expect(md).toContain('- [ ] Load test (blocked)');
    expect(md).toContain('- **Decision:** Use Stripe');
    expect(md).toContain('- **Epic:** ');
    expect(md).toContain('- **Question:** He said "ship it" \\& left');
  });

  it('keeps bodies as indented markdown and adds tags, links and relationships', () => {
    expect(md).toContain('  A **goal** with `code`.\n\n  - one\n  - two');
    expect(md).toContain('  - Tags: `goal`, `q3 plan`');
    expect(md).toContain('[src/pay/api.ts:12-40](src/pay/api.ts#L12-L40)');
    expect(md).toContain('symbol `src/api/auth.ts#login`');
    expect(md).toContain('commit `abc1234`');
    expect(md).toContain('[https://stripe.com/docs](https://stripe.com/docs)');
    expect(md).toContain('  - depends on: Payment API');
    expect(md).toContain('  - blocks: Write docs');
    expect(md).toContain('  - evidence for: Use Stripe (see "pricing" \\| fees)');
    expect(md).toContain('  - mentions: ');
  });

  it('escapes hostile titles so they cannot become markup', () => {
    expect(md).toContain('Use \\[x\\] \\{y\\} (z) \\<b\\>bold\\</b\\> \\| pipe');
    expect(md).toContain('First line second line');
    expect(md).toContain('\\# Heading \\*star\\* \\_under\\_ \\~strike\\~ \\$math\\$ \\\\slash');
    expect(md).not.toContain('<b>');
    expect(md).toContain(escapeMarkdown(HOSTILE.unicode));
  });

  it('does not add a roll-up section', () => {
    expect(md).not.toMatch(/open questions|risks/i);
  });

  it('can leave bodies out', () => {
    expect(toMarkdown(richBoard(), { bodies: false })).not.toContain('Stripe first.');
  });

  it('handles an empty board', () => {
    expect(toMarkdown(build([]))).toBe('# Main\n');
  });

  it('never links to a script URL', () => {
    const board = build([
      {
        op: 'add_node',
        node: { type: 'doc', title: 'x', links: [{ kind: 'url', target: 'javascript:alert(1)' }] },
      },
    ]);
    expect(toMarkdown(board)).toContain('`javascript:alert(1)`');
    expect(toMarkdown(board)).not.toContain('](javascript');
  });
});

describe('codeSpan', () => {
  it('fences text that contains backticks', () => {
    expect(codeSpan('a')).toBe('`a`');
    expect(codeSpan('a`b')).toBe('``a`b``');
    expect(codeSpan('`x`')).toBe('`` `x` ``');
  });
});
