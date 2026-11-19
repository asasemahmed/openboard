import { describe, expect, it } from 'vitest';
import { boardPath, legacyBoardRedirect, parseRoute } from './router.js';

describe('router', () => {
  it('parses board paths and optional card fragments', () => {
    expect(parseRoute('/b/main')).toEqual({ name: 'board', boardId: 'main' });
    expect(parseRoute('/b/main', '#n_123')).toEqual({
      name: 'board',
      boardId: 'main',
      cardId: 'n_123',
    });
    expect(parseRoute('/b/main', '#n%201')).toEqual({
      name: 'board',
      boardId: 'main',
      cardId: 'n 1',
    });
    expect(parseRoute('/b/main', '#')).toEqual({ name: 'board', boardId: 'main' });
    expect(parseRoute('/b/main', '#%ZZ')).toEqual({ name: 'board', boardId: 'main' });
    expect(parseRoute('/')).toEqual({ name: 'home' });
  });

  it('builds board and card paths', () => {
    expect(boardPath('main')).toBe('/b/main');
    expect(boardPath('main', 'n_123')).toBe('/b/main#n_123');
    expect(boardPath('a b', 'c d')).toBe('/b/a%20b#c%20d');
  });

  it('sends old ?board= links to /b/<id>', () => {
    expect(legacyBoardRedirect('/', '?board=main')).toBe('/b/main');
    expect(legacyBoardRedirect('/', '?board=a%20b')).toBe('/b/a%20b');
    expect(legacyBoardRedirect('/', '')).toBeNull();
    expect(legacyBoardRedirect('/b/other', '?board=main')).toBeNull();
  });
});
