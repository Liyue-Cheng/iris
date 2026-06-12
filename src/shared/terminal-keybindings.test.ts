import { describe, expect, it } from 'vitest';
import { matchKeybinding, type KeyEventLike } from './terminal-keybindings';

function ev(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...partial };
}

describe('matchKeybinding', () => {
  it('Ctrl+C → copy-or-sigint', () => {
    expect(matchKeybinding(ev({ ctrlKey: true, key: 'c' }))?.action).toBe('copy-or-sigint');
  });

  it('Cmd is equivalent to Ctrl', () => {
    expect(matchKeybinding(ev({ metaKey: true, key: 'c' }))?.action).toBe('copy-or-sigint');
  });

  it('Ctrl+Shift+C and Ctrl+Insert → copy-and-clear', () => {
    expect(matchKeybinding(ev({ ctrlKey: true, shiftKey: true, key: 'C' }))?.action).toBe(
      'copy-and-clear',
    );
    expect(matchKeybinding(ev({ ctrlKey: true, key: 'Insert' }))?.action).toBe('copy-and-clear');
  });

  it('all three paste keys → consume-for-paste', () => {
    expect(matchKeybinding(ev({ ctrlKey: true, key: 'v' }))?.action).toBe('consume-for-paste');
    expect(matchKeybinding(ev({ ctrlKey: true, shiftKey: true, key: 'V' }))?.action).toBe(
      'consume-for-paste',
    );
    expect(matchKeybinding(ev({ shiftKey: true, key: 'Insert' }))?.action).toBe(
      'consume-for-paste',
    );
  });

  it('does not hijack plain typing or unrelated chords', () => {
    expect(matchKeybinding(ev({ key: 'c' }))).toBeNull();
    expect(matchKeybinding(ev({ key: 'v' }))).toBeNull();
    expect(matchKeybinding(ev({ ctrlKey: true, key: 'x' }))).toBeNull();
    expect(matchKeybinding(ev({ ctrlKey: true, altKey: true, key: 'c' }))).toBeNull();
    // AltGr on Windows reports ctrl+alt — must not eat AltGr+C (ć etc.)
    expect(matchKeybinding(ev({ ctrlKey: true, altKey: true, key: 'v' }))).toBeNull();
  });
});
