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
  requestId: 'request-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
};

describe('IrisAgentToolHost', () => {
  it('reads and records write effects inside the active project', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-project-');
    const outputRoot = await createTempDataDir('iris-agent-tool-output-');
    try {
      const target = join(projectRoot, 'src', 'value.txt');
      await fs.mkdir(join(projectRoot, 'src'), { recursive: true });
      await fs.writeFile(target, 'before', 'utf8');
      const host = new IrisAgentToolHost({ projectRoot, outputRoot, commandShell });

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
      expect(write.event.state).toBe('completed');
      expect(write.event.diff).toContain('@@');
      expect(write.event.diff).toContain('-before');
      expect(write.event.diff).toContain('+after');
      expect(write.fileEffect?.beforeContent).toBe('before');
      expect(write.fileEffect?.afterContent).toBe('after');
    } finally {
      await removeTempDataDir(projectRoot);
      await removeTempDataDir(outputRoot);
    }
  });

  it('rejects unmanaged .iris document creation and interactive commands', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-project-');
    const outputRoot = await createTempDataDir('iris-agent-tool-output-');
    try {
      const host = new IrisAgentToolHost({ projectRoot, outputRoot, commandShell });
      const write = await host.execute(
        {
          tool: 'write',
          operation: 'writeFile',
          absolutePath: join(projectRoot, '.iris', 'issue', 'new.md'),
          content: 'no',
        },
        correlation,
      );
      expect(write.event.state).toBe('failed');
      expect(write.event.error).toContain('cannot create new .iris documents');

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
      expect(terminal.event.state).toBe('failed');
      expect(terminal.event.error).toContain('Interactive terminal commands');
    } finally {
      await removeTempDataDir(projectRoot);
      await removeTempDataDir(outputRoot);
    }
  });
});
