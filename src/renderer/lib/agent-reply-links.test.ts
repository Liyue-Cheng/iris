// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentReplyMarkdown } from '@renderer/components/agent/AgentReplyMarkdown';
import { openExternalUrl } from './shell-actions';

vi.mock('./shell-actions', () => ({ openExternalUrl: vi.fn(async () => undefined) }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Agent reply link ownership', () => {
  it.each(['https://example.com/a', 'mailto:example@example.com', './document.md'])(
    'prevents main-page navigation and delegates %s to the shell boundary', async href => {
      await act(async () => root.render(createElement(AgentReplyMarkdown, { content: `[link](${href})` })));
      const link = host.querySelector('a')!;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => { link.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
      expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(href);
    },
  );

  it('blocks unsafe protocols even if a generated reply contains them', async () => {
    await act(async () => root.render(createElement(AgentReplyMarkdown, { content: '[bad](javascript:alert%281%29)' })));
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { host.querySelector('a')!.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('owns middle-click navigation as well as ordinary link activation', async () => {
    await act(async () => root.render(createElement(AgentReplyMarkdown, { content: '[link](https://example.com/a)' })));
    const event = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
    await act(async () => { host.querySelector('a')!.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/a');
  });
});
