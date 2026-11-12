import { describe, expect, it } from 'vitest';
import { isTypingTarget, type KeyLike, matchesShortcut, shortcutKeys } from './shortcuts.js';

function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

describe('matchesShortcut', () => {
  it('matches plain keys case-insensitively and requires no modifiers', () => {
    expect(matchesShortcut(key('n'), 'n', true)).toBe(true);
    expect(matchesShortcut(key('N', { shiftKey: true }), 'n', true)).toBe(false);
    expect(matchesShortcut(key('n', { metaKey: true }), 'n', true)).toBe(false);
  });

  it('maps mod to Command on Mac and Control elsewhere', () => {
    expect(matchesShortcut(key('k', { metaKey: true }), 'mod+k', true)).toBe(true);
    expect(matchesShortcut(key('k', { ctrlKey: true }), 'mod+k', true)).toBe(false);
    expect(matchesShortcut(key('k', { ctrlKey: true }), 'mod+k', false)).toBe(true);
    expect(matchesShortcut(key('k', { metaKey: true }), 'mod+k', false)).toBe(false);
  });

  it('distinguishes undo from redo by shift', () => {
    expect(matchesShortcut(key('z', { metaKey: true }), 'mod+z', true)).toBe(true);
    expect(matchesShortcut(key('Z', { metaKey: true, shiftKey: true }), 'mod+z', true)).toBe(false);
    expect(matchesShortcut(key('Z', { metaKey: true, shiftKey: true }), 'shift+mod+z', true)).toBe(
      true,
    );
  });

  it('ignores shift for symbols that need it, and matches digits by code', () => {
    expect(matchesShortcut(key('?', { shiftKey: true }), '?', true)).toBe(true);
    expect(matchesShortcut(key('!', { shiftKey: true, code: 'Digit1' }), 'shift+1', true)).toBe(
      true,
    );
    expect(matchesShortcut(key('ArrowUp'), 'arrowup', true)).toBe(true);
    expect(matchesShortcut(key('ArrowUp', { shiftKey: true }), 'arrowup', true)).toBe(false);
  });

  it('never fires while composing text', () => {
    expect(matchesShortcut(key('n', { isComposing: true }), 'n', true)).toBe(false);
  });

  it('draws keys for the platform', () => {
    expect(shortcutKeys('shift+mod+z', true)).toEqual(['⌘', '⇧', 'Z']);
    expect(shortcutKeys('mod+k', false)).toEqual(['Ctrl', 'K']);
  });
});

describe('isTypingTarget', () => {
  it('is true for text fields and editable content, false otherwise', () => {
    const input = document.createElement('input');
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.append(inner);
    const button = document.createElement('button');
    document.body.append(input, checkbox, textarea, select, editable, button);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(select)).toBe(true);
    expect(isTypingTarget(inner)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
