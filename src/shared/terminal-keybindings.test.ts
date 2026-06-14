import { describe, expect, it } from 'vitest';
import { matchKeybinding, type KeyEventLike, type KeybindingContext } from './terminal-keybindings';

function ev(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...partial };
}

const NO_SEARCH: KeybindingContext = { searchVisible: false };
const SEARCH_OPEN: KeybindingContext = { searchVisible: true };

describe('matchKeybinding', () => {
  it('Ctrl+C → copy-or-sigint', () => {
    expect(matchKeybinding(ev({ ctrlKey: true, key: 'c' }), NO_SEARCH)?.action).toBe(
      'copy-or-sigint',
    );
  });

  it('Cmd is equivalent to Ctrl', () => {
    expect(matchKeybinding(ev({ metaKey: true, key: 'c' }), NO_SEARCH)?.action).toBe(
      'copy-or-sigint',
    );
  });

  it('Ctrl+Shift+C and Ctrl+Insert → copy-and-clear', () => {
    expect(matchKeybinding(ev({ ctrlKey: true, shiftKey: true, key: 'C' }), NO_SEARCH)?.action).toBe(
      'copy-and-clear',
    );
    expect(matchKeybinding(ev({ ctrlKey: true, key: 'Insert' }), NO_SEARCH)?.action).toBe(
      'copy-and-clear',
    );
  });

  it('all three paste keys → consume-for-paste', () => {
    expect(matchKeybinding(ev({ ctrlKey: true, key: 'v' }), NO_SEARCH)?.action).toBe(
      'consume-for-paste',
    );
    expect(matchKeybinding(ev({ ctrlKey: true, shiftKey: true, key: 'V' }), NO_SEARCH)?.action).toBe(
      'consume-for-paste',
    );
    expect(matchKeybinding(ev({ shiftKey: true, key: 'Insert' }), NO_SEARCH)?.action).toBe(
      'consume-for-paste',
    );
  });

  it('Ctrl+F → open-search', () => {
    expect(matchKeybinding(ev({ ctrlKey: true, key: 'f' }), NO_SEARCH)?.action).toBe('open-search');
  });

  it('Esc → close-search only when the search bar is visible', () => {
    expect(matchKeybinding(ev({ key: 'Escape' }), SEARCH_OPEN)?.action).toBe('close-search');
    // Search bar closed: Esc passes through to the PTY (no binding).
    expect(matchKeybinding(ev({ key: 'Escape' }), NO_SEARCH)).toBeNull();
  });

  it('does not hijack plain typing or unrelated chords', () => {
    expect(matchKeybinding(ev({ key: 'c' }), NO_SEARCH)).toBeNull();
    expect(matchKeybinding(ev({ key: 'v' }), NO_SEARCH)).toBeNull();
    expect(matchKeybinding(ev({ ctrlKey: true, key: 'x' }), NO_SEARCH)).toBeNull();
    expect(matchKeybinding(ev({ ctrlKey: true, altKey: true, key: 'c' }), NO_SEARCH)).toBeNull();
    // AltGr on Windows reports ctrl+alt — must not eat AltGr+C (ć etc.)
    expect(matchKeybinding(ev({ ctrlKey: true, altKey: true, key: 'v' }), NO_SEARCH)).toBeNull();
  });
});
