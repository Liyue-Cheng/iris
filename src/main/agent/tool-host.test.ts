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
  intentId: 'turn-1',
  turnId: 'execution-turn-1',
  toolCallId: 'tool-1',
  operationId: 'operation-1',
};

describe('IrisAgentToolHost', () => {
  it('writes files without creating a separate effect ledger', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-project-');
        try {
      const target = join(projectRoot, 'src', 'value.txt');
      await fs.mkdir(join(projectRoot, 'src'), { recursive: true });
      await fs.writeFile(target, 'before', 'utf8');
      const host = new IrisAgentToolHost({ projectRoot, commandShell });

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

    } finally {
      await removeTempDataDir(projectRoot);
    }
  });

  it('allows write tools to create managed documents in the first version', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-project-');
        try {
      const host = new IrisAgentToolHost({ projectRoot, commandShell });
      const write = await host.execute(
        {
          tool: 'write',
          operation: 'writeFile',
          absolutePath: join(projectRoot, '.iris', 'issue', 'new.md'),
          content: 'no',
        },
        correlation,
      );
      expect(write.update.state).toBe('completed');
      expect(await fs.readFile(join(projectRoot, '.iris', 'issue', 'new.md'), 'utf8')).toBe('no');

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
    }
  });

  it('allows every tool to follow arbitrary junction paths in the first version', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-link-project-');
        const outsideRoot = await createTempDataDir('iris-agent-tool-link-outside-');
    try {
      const linkedDirectory = join(projectRoot, 'linked');
      await fs.writeFile(join(outsideRoot, 'secret.txt'), 'outside', 'utf8');
      await fs.symlink(outsideRoot, linkedDirectory, 'junction');
      const host = new IrisAgentToolHost({
        projectRoot,
        commandShell,
      });

      const read = await host.execute(
        { tool: 'read', operation: 'readFile', absolutePath: join(linkedDirectory, 'secret.txt') },
        correlation,
      );
      expect(read.update.state).toBe('completed');
      expect(read.result).toMatchObject({
        kind: 'file',
        contentBase64: Buffer.from('outside').toString('base64'),
      });

      const access = await host.execute(
        { tool: 'read', operation: 'access', absolutePath: join(linkedDirectory, 'secret.txt') },
        correlation,
      );
      expect(access.update.state).toBe('completed');

      const mkdir = await host.execute(
        { tool: 'write', operation: 'mkdir', absolutePath: join(linkedDirectory, 'created') },
        correlation,
      );
      expect(mkdir.update.state).toBe('completed');
      await expect(fs.access(join(outsideRoot, 'created'))).resolves.toBeUndefined();

      const write = await host.execute(
        {
          tool: 'write',
          operation: 'writeFile',
          absolutePath: join(linkedDirectory, 'written.txt'),
          content: 'written outside',
        },
        correlation,
      );
      expect(write.update.state).toBe('completed');
      await expect(fs.readFile(join(outsideRoot, 'written.txt'), 'utf8')).resolves.toBe('written outside');

      const edit = await host.execute(
        {
          tool: 'edit',
          operation: 'writeFile',
          absolutePath: join(linkedDirectory, 'edited.txt'),
          content: 'edited outside',
        },
        correlation,
      );
      expect(edit.update.state).toBe('completed');
      await expect(fs.readFile(join(outsideRoot, 'edited.txt'), 'utf8')).resolves.toBe('edited outside');

      const terminal = await host.execute(
        {
          tool: 'terminal',
          operation: 'exec',
          command: 'Write-Output (Get-Location).Path',
          intent: 'information',
          cwd: linkedDirectory,
        },
        correlation,
      );
      expect(terminal.update.state).toBe('completed');
      expect(terminal.result).toMatchObject({ kind: 'terminal', exitCode: 0, success: true });
      if (terminal.result.kind === 'terminal') expect(terminal.result.outputText).toContain(linkedDirectory);
    } finally {
      await removeTempDataDir(projectRoot);
      await removeTempDataDir(outsideRoot);
    }
  });

  it('returns cleaned output for a nonzero exit while recording command failure', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-failure-project-');
        try {
      const host = new IrisAgentToolHost({ projectRoot, commandShell });
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
    }
  });

  it('uses explicitly allowed nonzero exit codes consistently', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-allowed-exit-project-');
        try {
      const host = new IrisAgentToolHost({ projectRoot, commandShell });
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
    }
  });

  it('records terminal launch failure separately from command failure', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-launch-project-');
        try {
      const host = new IrisAgentToolHost({
        projectRoot,
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
    }
  });
});
