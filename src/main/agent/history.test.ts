import { describe, expect, it } from 'vitest';
import { findCompletionNodes, forkHistoryPrefix, rewindMessageHistory } from './history';

const messages = [
  { id: 'u1', role: 'user' as const, content: 'one', turnId: 't1' },
  { id: 'a1', role: 'assistant' as const, content: 'done one', turnId: 't1' },
  { id: 'u2', role: 'user' as const, content: 'two', turnId: 't2' },
  { id: 'call', role: 'assistant' as const, content: 'tool', turnId: 't2', toolCallId: 'tool-1' },
  {
    id: 'result',
    role: 'tool' as const,
    content: 'ok',
    turnId: 't2',
    toolCallId: 'tool-1',
    toolSettled: true,
  },
  { id: 'a2', role: 'assistant' as const, content: 'done two', turnId: 't2' },
];

describe('Iris Agent linear history', () => {
  it('creates stable completion nodes only after every tool settles', () => {
    expect(findCompletionNodes(messages)).toEqual([
      { id: 'a1', turnId: 't1', messageIndex: 1 },
      { id: 'a2', turnId: 't2', messageIndex: 5 },
    ]);
    expect(findCompletionNodes(messages.slice(0, 4))).toEqual([
      { id: 'a1', turnId: 't1', messageIndex: 1 },
    ]);
  });

  it('rewinds only idle message history and does not retain a recoverable suffix', () => {
    const history = { messages, completionNodes: findCompletionNodes(messages) };
    expect(rewindMessageHistory(history, 'a1', 'idle').messages.map((item) => item.id)).toEqual([
      'u1',
      'a1',
    ]);
    expect(() => rewindMessageHistory(history, 'a1', 'running')).toThrow(/must be stopped/);
  });

  it('forks an independent linear prefix from a completed node', () => {
    const history = { messages, completionNodes: findCompletionNodes(messages) };
    const fork = forkHistoryPrefix(history, 'a1');
    fork.messages[0]!.content = 'fork-only';
    expect(history.messages[0]!.content).toBe('one');
    expect(fork.messages.map((item) => item.id)).toEqual(['u1', 'a1']);
  });
});

