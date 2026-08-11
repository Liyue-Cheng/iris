import type { Terminal } from '@xterm/xterm';
import { attachImeCompositionEndCleaner } from '@shared/ime-textarea-workaround';
import {
  attachImeCompositionPositionLock,
  type BufferServiceLike,
  type CompositionHelperLike,
} from '@shared/ime-composition-position-lock';

interface XtermPrivateCore {
  _compositionHelper?: CompositionHelperLike;
  _bufferService?: BufferServiceLike;
}

export interface XtermCompatLogger {
  warn(message: string, error?: unknown): void;
}

export function attachTerminalImeCompatibility(
  term: Terminal,
  textarea: HTMLTextAreaElement | null,
  log: XtermCompatLogger = console,
): () => void {
  if (!textarea) return () => undefined;
  const detach: Array<() => void> = [];
  try {
    detach.push(attachImeCompositionEndCleaner(textarea));
  } catch (error) {
    log.warn('[terminal] IME backlog cleaner attach failed', error);
  }

  try {
    const core = (term as unknown as { _core?: XtermPrivateCore })._core;
    const helper = core?._compositionHelper;
    const bufferService = core?._bufferService;
    if (
      helper &&
      typeof helper.updateCompositionElements === 'function' &&
      bufferService?.buffer &&
      typeof bufferService.buffer.x === 'number' &&
      typeof bufferService.buffer.y === 'number'
    ) {
      detach.push(attachImeCompositionPositionLock(textarea, helper, bufferService));
    } else {
      log.warn('[terminal] IME position lock skipped because the xterm private API changed');
    }
  } catch (error) {
    log.warn('[terminal] IME position lock attach failed', error);
  }

  return () => {
    for (const dispose of detach.reverse()) dispose();
  };
}
