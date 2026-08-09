// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachCodeBlockCopyFeedback,
  retainInitializedCodeBlock,
} from './stable-code-block';

afterEach(() => {
  vi.useRealTimers();
});

describe('attachCodeBlockCopyFeedback', () => {
  it('shows feedback only on the clicked copy button, then restores it', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="milkdown-code-block"><button class="copy-button"><span>copy</span></button></div>
      <div class="milkdown-code-block"><button class="copy-button">copy</button></div>
    `;
    const buttons = root.querySelectorAll<HTMLButtonElement>('.copy-button');
    const first = buttons[0];
    const second = buttons[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const detach = attachCodeBlockCopyFeedback(root, 1500);
    first!.querySelector('span')!.click();

    expect(first!.getAttribute('data-copy-feedback')).toBe('copied');
    expect(second!.hasAttribute('data-copy-feedback')).toBe(false);

    vi.advanceTimersByTime(1499);
    expect(first!.getAttribute('data-copy-feedback')).toBe('copied');
    vi.advanceTimersByTime(1);
    expect(first!.hasAttribute('data-copy-feedback')).toBe(false);

    detach();
  });

  it('restarts the timer on another click and clears pending state on detach', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.innerHTML =
      '<div class="milkdown-code-block"><button class="copy-button">copy</button></div>';
    const button = root.querySelector<HTMLButtonElement>('.copy-button')!;
    const detach = attachCodeBlockCopyFeedback(root, 1000);

    button.click();
    vi.advanceTimersByTime(800);
    button.click();
    vi.advanceTimersByTime(800);
    expect(button.getAttribute('data-copy-feedback')).toBe('copied');

    detach();
    expect(button.hasAttribute('data-copy-feedback')).toBe(false);
    vi.runAllTimers();
    expect(button.hasAttribute('data-copy-feedback')).toBe(false);
  });
});

describe('retainInitializedCodeBlock', () => {
  it('disables off-screen teardown only on the Iris-owned NodeView instance', () => {
    let scheduled = 0;
    const prototype = {
      scheduleTeardown(): void {
        scheduled += 1;
      },
      setSelection(): void {},
    };
    const first = Object.create(prototype) as object;
    const second = Object.create(prototype) as object;

    retainInitializedCodeBlock(first);
    retainInitializedCodeBlock(first);
    Reflect.apply(Reflect.get(first, 'scheduleTeardown'), first, []);
    Reflect.apply(Reflect.get(second, 'scheduleTeardown'), second, []);

    expect(scheduled).toBe(1);
    expect(Object.hasOwn(first, 'scheduleTeardown')).toBe(true);
    expect(Object.hasOwn(second, 'scheduleTeardown')).toBe(false);
    expect(Reflect.get(prototype, 'scheduleTeardown')).toBe(prototype.scheduleTeardown);
    expect(Object.getOwnPropertyDescriptor(first, 'scheduleTeardown')).toMatchObject({
      configurable: false,
      writable: false,
    });
  });

  it('fails loudly when a Milkdown upgrade removes the lifecycle hook', () => {
    expect(() => retainInitializedCodeBlock({})).toThrow(/scheduleTeardown is missing/);
  });

  it('clamps ProseMirror selection offsets to the CodeMirror document', () => {
    const selections: Array<[number, number]> = [];
    const prototype = {
      scheduleTeardown(): void {},
      setSelection(anchor: number, head: number): void {
        selections.push([anchor, head]);
      },
    };
    const block = Object.assign(Object.create(prototype) as object, {
      node: { textContent: 'abc' },
    });

    retainInitializedCodeBlock(block);
    Reflect.apply(Reflect.get(block, 'setSelection'), block, [-2, 8]);

    expect(selections).toEqual([[0, 3]]);
  });
});
