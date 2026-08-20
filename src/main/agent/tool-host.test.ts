import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDataDir, removeTempDataDir } from '../persistence';
import { IrisAgentToolHost } from './tool-host';

const commandShell = {
  kind: 'powershell' as const,
  executable: 'pwsh.exe',
  displayName: 'PowerShell 7',
};

const correlation = {
  sessionId: 'agent-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
  operationId: 'operation-1',
};

describe('IrisAgentToolHost', () => {
  it('reads and records write effects inside the active project', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-project-');
    const artifactRoot = await createTempDataDir('iris-agent-tool-output-');
    try {
      const target = join(projectRoot, 'src', 'value.txt');
      await fs.mkdir(join(projectRoot, 'src'), { recursive: true });
      await fs.writeFile(target, 'before', 'utf8');
      const host = new IrisAgentToolHost({ projectRoot, artifactRoot, commandShell });

      const read = await host.execute(
        { tool: 'read', operation: 'readFile', absolutePath: target },
        correlation,
      );
      expect(read.result).toEqual({
        kind: 'file',
        contentBase64: Buffer.from('before').toString('base64'),
      });

      const write = await host.execute(
        { tool: 'edit', operation: 'writeFile', absolutePath: target, content: 'after' },
        correlation,
      );
      expect(await fs.readFile(target, 'utf8')).toBe('after');
      expect(write.update.state).toBe('completed');
      expect(write.update.diff).toContain('@@');
      expect(write.update.diff).toContain('-before');
      expect(write.update.diff).toContain('+after');
      expect(write.effects[0]).toMatchObject({
        kind: 'file-write', turnId: 'turn-1', artifactRef: expect.stringMatching(/^effects\//u),
      });
      const effect = write.effects[0]!;
      expect(effect.kind).toBe('file-write');
      if (effect.kind === 'file-write') {
        const payload = JSON.parse(await fs.readFile(join(artifactRoot, ...effect.artifactRef.split('/')), 'utf8'));
        expect(payload).toMatchObject({ beforeContent: 'before', afterContent: 'after' });
      }
    } finally {
      await removeTempDataDir(projectRoot);
      await removeTempDataDir(artifactRoot);
    }
  });

  it('rejects unmanaged .iris document creation and interactive commands', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-project-');
    const artifactRoot = await createTempDataDir('iris-agent-tool-output-');
    try {
      const host = new IrisAgentToolHost({ projectRoot, artifactRoot, commandShell });
      const write = await host.execute(
        {
          tool: 'write',
          operation: 'writeFile',
          absolutePath: join(projectRoot, '.iris', 'issue', 'new.md'),
          content: 'no',
        },
        correlation,
      );
      expect(write.update.state).toBe('failed');
      expect(write.update.error).toContain('cannot create new .iris documents');

      const terminal = await host.execute(
        {
          tool: 'terminal',
          operation: 'exec',
          command: 'node',
          intent: 'operation',
          cwd: projectRoot,
        },
        correlation,
      );
      expect(terminal.update.state).toBe('failed');
      expect(terminal.update.error).toContain('Interactive terminal commands');
    } finally {
      await removeTempDataDir(projectRoot);
      await removeTempDataDir(artifactRoot);
    }
  });
});
