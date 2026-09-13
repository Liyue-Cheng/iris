import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDataDir, removeTempDataDir } from '../persistence';
import { AGENT_READ_IMAGE_MAX_BYTES, JtpNativeExecution } from './native-execution';

/** A PNG header plus padding, so the byte count is stable and predictable. */
function pngFixture(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(777)]);
}

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

describe('JtpNativeExecution', () => {
  it('rejects patch text and empty edit lists without changing the file', async () => {
    const projectRoot = await createTempDataDir('iris-agent-edit-guard-');
    try {
      const target = join(projectRoot, 'src', 'value.ts');
      await fs.mkdir(join(projectRoot, 'src'), { recursive: true });
      await fs.writeFile(target, 'const value = 1;\n', 'utf8');
      const host = new JtpNativeExecution({ projectRoot, commandShell });

      const empty = await host.execute(
        { tool: 'edit', operation: 'writeFile', absolutePath: target, edits: [] },
        correlation,
      );
      expect(empty.update.state).toBe('failed');
      expect(await fs.readFile(target, 'utf8')).toBe('const value = 1;\n');

      const patch = await host.execute(
        {
          tool: 'edit',
          operation: 'writeFile',
          absolutePath: target,
          edits: [{ oldText: '*** Begin Patch', newText: '' }],
        },
        correlation,
      );
      expect(patch.update.state).toBe('failed');
      expect(await fs.readFile(target, 'utf8')).toBe('const value = 1;\n');
    } finally {
      await removeTempDataDir(projectRoot);
    }
  });

  it('writes files without creating a separate effect ledger', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-project-');
        try {
      const target = join(projectRoot, 'src', 'value.txt');
      await fs.mkdir(join(projectRoot, 'src'), { recursive: true });
      await fs.writeFile(target, 'before', 'utf8');
      const host = new JtpNativeExecution({ projectRoot, commandShell });

      const read = await host.execute(
        { tool: 'read', operation: 'readFile', absolutePath: target },
        correlation,
      );
      expect(read.result).toEqual({
        kind: 'file',
        contentBase64: Buffer.from('before').toString('base64'),
      });

      const write = await host.execute(
        {
          tool: 'edit',
          operation: 'writeFile',
          absolutePath: target,
          edits: [{ oldText: 'before', newText: 'after' }],
        },
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

  it('returns image bytes for an image read instead of decoding them as text', async () => {
    const projectRoot = await createTempDataDir('iris-agent-read-image-');
    try {
      const target = join(projectRoot, 'shot.png');
      const bytes = pngFixture(1280, 720);
      await fs.writeFile(target, bytes);
      const host = new JtpNativeExecution({ projectRoot, commandShell });
      const result = await host.execute(
        { tool: 'read', operation: 'readFile', absolutePath: target },
        correlation,
      );
      expect(result.result).toEqual({
        kind: 'image',
        mimeType: 'image/png',
        contentBase64: bytes.toString('base64'),
        bytes: bytes.byteLength,
        width: 1280,
        height: 720,
      });
      expect(result.update.state).toBe('completed');
      expect(result.update.resultSummary).toBe('image/png 1280x720 801 B');
      // Text paging parameters are text-only; the image still arrives whole.
      const paged = await host.execute(
        { tool: 'read', operation: 'readFile', absolutePath: target, offset: 2, limit: 2 },
        correlation,
      );
      expect(paged.result).toMatchObject({ kind: 'image', width: 1280, height: 720 });
    } finally {
      await removeTempDataDir(projectRoot);
    }
  });

  it('keeps the text path for an unsupported or oversized image', async () => {
    const projectRoot = await createTempDataDir('iris-agent-read-image-guard-');
    try {
      const svg = join(projectRoot, 'vector.svg');
      await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
      const oversized = join(projectRoot, 'huge.png');
      await fs.writeFile(oversized, Buffer.concat([
        pngFixture(1, 1),
        Buffer.alloc(AGENT_READ_IMAGE_MAX_BYTES + 1),
      ]));
      const host = new JtpNativeExecution({ projectRoot, commandShell });

      const vector = await host.execute(
        { tool: 'read', operation: 'readFile', absolutePath: svg },
        correlation,
      );
      expect(vector.result.kind).toBe('file');

      // Over the ceiling the read still succeeds, it just stops pretending the
      // bytes are an image the model should pay context for.
      const tooLarge = await host.execute(
        { tool: 'read', operation: 'readFile', absolutePath: oversized },
        correlation,
      );
      expect(tooLarge.result.kind).toBe('file');
    } finally {
      await removeTempDataDir(projectRoot);
    }
  });

  it('never hands an image to the edit tool, which needs text semantics', async () => {
    const projectRoot = await createTempDataDir('iris-agent-edit-image-');
    try {
      const target = join(projectRoot, 'shot.png');
      await fs.writeFile(target, pngFixture(8, 8));
      const host = new JtpNativeExecution({ projectRoot, commandShell });
      const result = await host.execute(
        { tool: 'edit', operation: 'readFile', absolutePath: target },
        correlation,
      );
      expect(result.result.kind).toBe('file');
    } finally {
      await removeTempDataDir(projectRoot);
    }
  });

  it('matches Pi read offset/limit behavior and returns continuation guidance', async () => {
    const projectRoot = await createTempDataDir('iris-agent-read-range-');
    try {
      const target = join(projectRoot, 'lines.txt');
      await fs.writeFile(target, 'one\ntwo\nthree\nfour\n', 'utf8');
      const host = new JtpNativeExecution({ projectRoot, commandShell });
      const result = await host.execute(
        { tool: 'read', operation: 'readFile', absolutePath: target, offset: 2, limit: 2 },
        correlation,
      );
      expect(result.result).toMatchObject({ kind: 'file' });
      if (result.result.kind === 'file') {
        expect(Buffer.from(result.result.contentBase64, 'base64').toString('utf8'))
          .toContain('two\nthree');
        expect(Buffer.from(result.result.contentBase64, 'base64').toString('utf8'))
          .toContain('Use offset=4 to continue');
      }
    } finally {
      await removeTempDataDir(projectRoot);
    }
  });

  it('allows write tools to create managed documents in the first version', async () => {
    const projectRoot = await createTempDataDir('iris-agent-tool-project-');
        try {
      const host = new JtpNativeExecution({ projectRoot, commandShell });
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
          timeout: 30,
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
      const host = new JtpNativeExecution({
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
      await fs.writeFile(join(outsideRoot, 'edited.txt'), 'outside', 'utf8');

      const edit = await host.execute(
        {
          tool: 'edit',
          operation: 'writeFile',
          absolutePath: join(linkedDirectory, 'edited.txt'),
          edits: [{ oldText: 'outside', newText: 'edited outside' }],
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
          timeout: 30,
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
      const host = new JtpNativeExecution({ projectRoot, commandShell });
      const terminal = await host.execute(
        {
          tool: 'terminal',
          operation: 'exec',
          command: "Write-Output 'before failure'; exit 7",
          intent: 'operation',
          timeout: 30,
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
      const host = new JtpNativeExecution({ projectRoot, commandShell });
      const terminal = await host.execute(
        {
          tool: 'terminal',
          operation: 'exec',
          command: 'exit 1',
          intent: 'information',
          timeout: 30,
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
      const host = new JtpNativeExecution({
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
          timeout: 30,
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



