import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSessionViewportState,
  getSessionViewportState,
  SessionViewportController,
} from './session-viewport';

interface ViewportValues {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

function viewport(values: ViewportValues): HTMLElement {
  const listeners = new Set<{ type: string; listener: EventListener }>();
  return {
    get scrollHeight() { return values.scrollHeight; },
    get clientHeight() { return values.clientHeight; },
    get scrollTop() { return values.scrollTop; },
    set scrollTop(value: number) { values.scrollTop = value; },
    addEventListener(type: string, listener: EventListener) {
      listeners.add({ type, listener });
    },
    removeEventListener(type: string, listener: EventListener) {
      for (const entry of listeners) {
        if (entry.type === type && entry.listener === listener) {
          listeners.delete(entry);
          return;
        }
      }
    },
    dispatchEvent(event: Event) {
      for (const entry of listeners) {
        if (entry.type === event.type) entry.listener(event);
      }
      return true;
    },
  } as unknown as HTMLElement;
}

function makeResizeObserver(): { notify: () => void } {
  let callback: (() => void) | undefined;
  class ResizeObserverFake {
    constructor(cb: () => void) { callback = cb; }
    observe(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverFake);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  return { notify: () => callback?.() };
}

/** Open the interaction gate the way a real user wheel gesture would, then fire
 * a scroll event so the controller reads the (already-moved) scrollTop. */
function userScrollUp(element: HTMLElement, values: ViewportValues, target: number): void {
  values.scrollTop = target;
  element.dispatchEvent(new Event('wheel'));
  element.dispatchEvent(new Event('scroll'));
}

afterEach(() => {
  clearSessionViewportState();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SessionViewportController', () => {
  it('pins a fresh mount (no memory) to the bottom in follow mode', () => {
    const values: ViewportValues = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    const element = viewport(values);
    makeResizeObserver();
    const controller = new SessionViewportController('iris-agent:b', element);
    expect(getSessionViewportState('iris-agent:b')?.mode).toBe('follow-bottom');
    expect(values.scrollTop).toBe(800);
    controller.dispose();
  });

  it('keeps a followed Session pinned to the bottom after content grows', () => {
    const values: ViewportValues = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    const element = viewport(values);
    const observer = makeResizeObserver();
    const controller = new SessionViewportController('iris-agent:b', element);
    expect(values.scrollTop).toBe(800);
    values.scrollHeight = 1200;
    observer.notify();
    controller.dispose();
    expect(values.scrollTop).toBe(1000);
  });

  it('does not change mode on a non-interactive scroll event', () => {
    const values: ViewportValues = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    const element = viewport(values);
    makeResizeObserver();
    const controller = new SessionViewportController('iris-agent:b', element);
    // Content grows and a programmatic scroll fires (no wheel/touch/pointer).
    // Even though the distance momentarily exceeds the exit threshold, the
    // absence of a user gesture must keep the session frozen-free.
    values.scrollHeight = 2000;
    element.dispatchEvent(new Event('scroll'));
    expect(getSessionViewportState('iris-agent:b')?.mode).toBe('follow-bottom');
    controller.dispose();
  });

  it('freezes the view when the user scrolls up, then keeps scrollTop stable on growth', () => {
    const values: ViewportValues = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    const element = viewport(values);
    const observer = makeResizeObserver();
    const controller = new SessionViewportController('iris-agent:b', element);
    // User wheels up to read history (distance > EXIT threshold).
    userScrollUp(element, values, 500);
    expect(getSessionViewportState('iris-agent:b')?.mode).toBe('free');
    const frozenTop = values.scrollTop;
    expect(frozenTop).toBe(500);
    // Content streams in below the frozen viewport; the reader's position
    // must not be yanked down or up.
    values.scrollHeight = 2000;
    observer.notify();
    controller.dispose();
    expect(values.scrollTop).toBe(frozenTop);
  });

  it('re-follows the bottom once the user scrolls back down', () => {
    const values: ViewportValues = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    const element = viewport(values);
    makeResizeObserver();
    const controller = new SessionViewportController('iris-agent:b', element);
    userScrollUp(element, values, 500);
    expect(getSessionViewportState('iris-agent:b')?.mode).toBe('free');
    // User scrolls back to the bottom; within the enter threshold → follow.
    values.scrollTop = 800;
    element.dispatchEvent(new Event('wheel'));
    element.dispatchEvent(new Event('scroll'));
    expect(getSessionViewportState('iris-agent:b')?.mode).toBe('follow-bottom');
    controller.dispose();
  });

  it('restores a frozen position per SessionKey after a switch', () => {
    const values: ViewportValues = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    const element = viewport(values);
    makeResizeObserver();
    const controller = new SessionViewportController('iris-agent:a', element);
    userScrollUp(element, values, 400);
    expect(getSessionViewportState('iris-agent:a')?.mode).toBe('free');
    controller.dispose();

    // Remount with a fresh, content-bearing viewport of the same key.
    const secondValues: ViewportValues = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    const second = viewport(secondValues);
    new SessionViewportController('iris-agent:a', second).dispose();
    expect(getSessionViewportState('iris-agent:a')?.mode).toBe('free');
    expect(secondValues.scrollTop).toBe(400);
  });

  it('invalidates late events after dispose — they never mutate memory', () => {
    const values: ViewportValues = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    const element = viewport(values);
    makeResizeObserver();
    const controller = new SessionViewportController('iris-agent:b', element);
    controller.dispose();
    const before = getSessionViewportState('iris-agent:b');
    // Late events after dispose must be no-ops (listeners already removed).
    element.dispatchEvent(new Event('scroll'));
    element.dispatchEvent(new Event('wheel'));
    expect(getSessionViewportState('iris-agent:b')).toEqual(before);
  });
});
