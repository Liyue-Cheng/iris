import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalViewportController } from './viewport-controller';

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalViewportController', () => {
  it('gates normal fits during replay and applies one deferred fit on completion', () => {
    const fit = vi.fn();
    const viewport = new TerminalViewportController({ fit }, 150);
    viewport.requestFit();
    viewport.requestFit();
    expect(fit).not.toHaveBeenCalled();
    viewport.finishReplay();
    expect(fit).toHaveBeenCalledOnce();
  });

  it('uses trailing debounce and flushes before input', () => {
    vi.useFakeTimers();
    const fit = vi.fn();
    const viewport = new TerminalViewportController({ fit }, 150);
    viewport.finishReplay();
    viewport.scheduleFit();
    viewport.scheduleFit();
    vi.advanceTimersByTime(149);
    expect(fit).not.toHaveBeenCalled();
    viewport.flushBeforeInput();
    expect(fit).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(fit).toHaveBeenCalledOnce();
  });

  it('does not apply a scheduled fit after disposal', () => {
    vi.useFakeTimers();
    const fit = vi.fn();
    const viewport = new TerminalViewportController({ fit }, 150);
    viewport.finishReplay();
    viewport.scheduleFit();
    viewport.dispose();
    vi.runAllTimers();
    expect(fit).not.toHaveBeenCalled();
  });
});
