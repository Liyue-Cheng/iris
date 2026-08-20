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

  it('rejects unmanaged .iris document creation without classifying command text as interactive', async () => {
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
          command: "Write-Output 'tsconfig.node.json'",
          intent: 'information',
          cwd: projectRoot,
        },
        correlation,
      );
      expect(terminal.update.state).toBe('completed');
      expect(terminal.result).toMatchObject({ kind: 'terminal', exitCode: 0 });
      if (terminal.result.kind === 'terminal') {
        expect(terminal.result.outputText).toContain('tsconfig.node.json');
      }
    } finally {
      await removeTempDataDir(projectRoot);
      await removeTempDataDir(artifactRoot);
    }
  });

  it('returns cleaned output for a nonzero exit while recording command failure', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-failure-project-');
    const artifactRoot = await createTempDataDir('iris-agent-tool-failure-output-');
    try {
      const host = new IrisAgentToolHost({ projectRoot, artifactRoot, commandShell });
      const terminal = await host.execute(
        {
          tool: 'terminal',
          operation: 'exec',
          command: "Write-Output 'before failure'; exit 7",
          intent: 'operation',
          cwd: projectRoot,
        },
        correlation,
      );
      expect(terminal.update).toMatchObject({
        state: 'failed',
        error: 'Command exited with code 7.',
        terminalOutcome: 'command-failed',
        terminalExitCode: 7,
      });
      expect(terminal.result).toMatchObject({
        kind: 'terminal',
        exitCode: 7,
        success: false,
        outputTruncated: false,
      });
      if (terminal.result.kind === 'terminal') {
        expect(terminal.result.outputText).toContain('before failure');
        expect(terminal.result.outputText).not.toContain('\u001b[');
      }
    } finally {
      await removeTempDataDir(projectRoot);
      await removeTempDataDir(artifactRoot);
    }
  });

  it('uses explicitly allowed nonzero exit codes consistently', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-allowed-exit-project-');
    const artifactRoot = await createTempDataDir('iris-agent-tool-allowed-exit-output-');
    try {
      const host = new IrisAgentToolHost({ projectRoot, artifactRoot, commandShell });
      const terminal = await host.execute(
        {
          tool: 'terminal',
          operation: 'exec',
          command: 'exit 1',
          intent: 'information',
          cwd: projectRoot,
          successExitCodes: [0, 1],
        },
        correlation,
      );
      expect(terminal.update).toMatchObject({
        state: 'completed',
        terminalOutcome: 'success',
        terminalExitCode: 1,
        terminalSuccessExitCodes: [0, 1],
      });
      expect(terminal.result).toMatchObject({ kind: 'terminal', exitCode: 1, success: true });
    } finally {
      await removeTempDataDir(projectRoot);
      await removeTempDataDir(artifactRoot);
    }
  });

  it('records terminal launch failure separately from command failure', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-launch-project-');
    const artifactRoot = await createTempDataDir('iris-agent-tool-launch-output-');
    try {
      const host = new IrisAgentToolHost({
        projectRoot,
        artifactRoot,
        commandShell,
        terminalFactory: () => { throw new Error('simulated spawn failure'); },
      });
      const terminal = await host.execute(
        {
          tool: 'terminal',
          operation: 'exec',
          command: 'missing-command',
          intent: 'operation',
          cwd: projectRoot,
        },
        correlation,
      );
      expect(terminal.update).toMatchObject({
        state: 'failed',
        terminalState: 'exited',
        terminalOutcome: 'launch-failed',
        error: 'simulated spawn failure',
      });
      expect(terminal.result).toEqual({ kind: 'void' });
    } finally {
      await removeTempDataDir(projectRoot);
      await removeTempDataDir(artifactRoot);
    }
  });
});
