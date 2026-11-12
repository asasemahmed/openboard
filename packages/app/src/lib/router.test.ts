import { describe, expect, it } from 'vitest';
import { legacyBoardRedirect, parseRoute } from './router.js';

describe('router', () => {
  it('parses board paths', () => {
    expect(parseRoute('/b/main')).toEqual({ name: 'board', boardId: 'main' });
    expect(parseRoute('/')).toEqual({ name: 'home' });
  });

  it('sends old ?board= links to /b/<id>', () => {
    expect(legacyBoardRedirect('/', '?board=main')).toBe('/b/main');
    expect(legacyBoardRedirect('/', '?board=a%20b')).toBe('/b/a%20b');
    expect(legacyBoardRedirect('/', '')).toBeNull();
    expect(legacyBoardRedirect('/b/other', '?board=main')).toBeNull();
  });
});
