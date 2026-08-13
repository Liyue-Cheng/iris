import { describe, expect, it } from 'vitest';
import { createTempDataDir, removeTempDataDir } from '../persistence';
import { IrisAgentSessionStore } from './session-store';
import type { IrisAgentSessionInfo } from '@shared/types';

function session(projectRoot: string, state: IrisAgentSessionInfo['state']): IrisAgentSessionInfo {
  return {
    id: 'agent-1',
    kind: 'iris-agent',
    anchor: { kind: 'document', path: '.iris/issue/task.md' },
    projectRoot,
    projectGeneration: 1,
    displayName: 'Iris Agent',
    state,
    createdAt: 1,
    updatedAt: 1,
    activeTurnId: 'turn-1',
    messages: [{
      id: 'user-1',
      turnId: 'turn-1',
      role: 'user',
      content: 'hello',
      createdAt: 1,
    }],
    turns: [{
      id: 'turn-1',
      userMessageId: 'user-1',
      requestId: 'request-1',
      status: 'running',
      createdAt: 1,
    }],
    toolEvents: [],
    fileEffects: [],
    requestFacts: [],
    selfHostingEligible: false,
  };
}

describe('IrisAgentSessionStore', () => {
  it('persists sessions and recovers interrupted turns after restart', async () => {
    const dataDir = await createTempDataDir('iris-agent-store-');
    const projectRoot = await createTempDataDir('iris-agent-project-');
    try {
      const first = await IrisAgentSessionStore.load({
        userDataPath: dataDir,
        projectRoot,
        debounceMs: 0,
      });
      first.upsert(session(projectRoot, 'running'));
      await first.flush();
      first.destroy();

      const second = await IrisAgentSessionStore.load({
        userDataPath: dataDir,
        projectRoot,
        debounceMs: 0,
      });
      const [restored] = second.list({ root: projectRoot, generation: 2 });
      expect(restored?.state).toBe('failed');
      expect(restored?.projectGeneration).toBe(2);
      expect(restored?.activeTurnId).toBeNull();
      expect(restored?.turns[0]?.status).toBe('failed');
      second.destroy();
    } finally {
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });
});
