export type AgentHistoryRole = 'user' | 'assistant' | 'tool';

export interface AgentHistoryMessage {
  id: string;
  role: AgentHistoryRole;
  content: string;
  turnId: string;
  toolCallId?: string;
  toolSettled?: boolean;
}

export interface AgentCompletionNode {
  id: string;
  turnId: string;
  messageIndex: number;
}

export interface AgentLinearHistory {
  messages: AgentHistoryMessage[];
  completionNodes: AgentCompletionNode[];
}

export function findCompletionNodes(messages: readonly AgentHistoryMessage[]): AgentCompletionNode[] {
  const nodes: AgentCompletionNode[] = [];
  const pendingTools = new Set<string>();

  messages.forEach((message, messageIndex) => {
    if (message.toolCallId && message.role === 'assistant') pendingTools.add(message.toolCallId);
    if (message.toolCallId && message.role === 'tool' && message.toolSettled) {
      pendingTools.delete(message.toolCallId);
    }
    const next = messages[messageIndex + 1];
    const turnEnds = !next || next.turnId !== message.turnId;
    if (turnEnds && message.role === 'assistant' && pendingTools.size === 0) {
      nodes.push({ id: message.id, turnId: message.turnId, messageIndex });
    }
  });
  return nodes;
}

export function rewindMessageHistory(
  history: AgentLinearHistory,
  nodeId: string,
  state: 'idle' | 'running' | 'waiting-tool',
): AgentLinearHistory {
  if (state !== 'idle') throw new Error('Agent session must be stopped before message rewind');
  const node = history.completionNodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Unknown or incomplete history node: ${nodeId}`);
  const messages = history.messages.slice(0, node.messageIndex + 1);
  return { messages, completionNodes: findCompletionNodes(messages) };
}

export function forkHistoryPrefix(
  history: AgentLinearHistory,
  nodeId: string,
): AgentLinearHistory {
  const node = history.completionNodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Fork target must be a completed history node: ${nodeId}`);
  const messages = history.messages.slice(0, node.messageIndex + 1).map((message) => ({ ...message }));
  return { messages, completionNodes: findCompletionNodes(messages) };
}

