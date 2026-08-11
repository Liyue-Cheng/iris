import { describe, expect, it } from 'vitest';
import { reduceTerminalProcess } from './process-reducer';

describe('terminal process reducer', () => {
  it('keeps process lifetime separate from activity state', () => {
    expect(reduceTerminalProcess('spawning', { type: 'SPAWNED' })).toBe('running');
    expect(reduceTerminalProcess('running', { type: 'CLOSE' })).toBe('closing');
    expect(reduceTerminalProcess('closing', { type: 'EXITED' })).toBe('exited');
    expect(reduceTerminalProcess('exited', { type: 'DISPOSE' })).toBe('disposed');
  });

  it('makes disposed terminal and ignores invalid transitions', () => {
    expect(reduceTerminalProcess('running', { type: 'SPAWNED' })).toBe('running');
    expect(reduceTerminalProcess('disposed', { type: 'CLOSE' })).toBe('disposed');
  });
});
