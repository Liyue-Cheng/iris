import type { Terminal } from '@xterm/xterm';
import { isTerminalFocusReport } from '@shared/terminal/input-policy';

/**
 * xterm's public onData merges parser replies and actual input. Its core marks
 * keyboard/IME/paste/SGR mouse input explicitly; focus reports are the one
 * interactive exception. Keep this version-sensitive bridge in one place.
 */
export function ownBrowserTerminalInput(terminal: Terminal): () => void {
  const core = (terminal as unknown as {
    _core?: { coreService?: { triggerDataEvent(data: string, wasUserInput?: boolean): void } };
  })._core?.coreService;
  if (!core || typeof core.triggerDataEvent !== 'function') {
    throw new Error('Unsupported xterm input API: cannot separate input from terminal replies.');
  }
  const original = core.triggerDataEvent;
  core.triggerDataEvent = function (data, wasUserInput = false) {
    if (wasUserInput || isTerminalFocusReport(data)) original.call(this, data, wasUserInput);
  };
  return () => { core.triggerDataEvent = original; };
}
