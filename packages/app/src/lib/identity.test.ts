import { describe, expect, it } from 'vitest';
import { colorFor } from './identity.js';

describe('colorFor with untrusted colours', () => {
  it('ignores anything that is not a hex colour', () => {
    const actor = { id: 'a_1', kind: 'human' as const, color: 'url(//example.test/x)' };
    expect(colorFor(actor)).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(colorFor({ ...actor, color: '#123abc' })).toBe('#123abc');
  });
});
