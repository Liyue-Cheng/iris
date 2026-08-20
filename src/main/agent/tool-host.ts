import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { AgentCommandPty } from './command-pty';
import { writeFileAtomic } from '../atomic-write';
import { generateUnifiedPatch } from '@earendil-works/pi-coding-agent';
import type {
  AgentCommandShell,
  AgentCorrelation,
  AgentToolOperationInput,
  AgentToolOperationResult,
} from '@shared/agent-protocol';
import type {
  AgentEffect,
  AgentDirectoryEffect,
  AgentFileEffect,
  AgentToolActivity,
  AgentTerminalEffect,
} from './session-model';

export interface IrisAgentToolHostResult {
  result: AgentToolOperationResult;
  update: { state: AgentToolActivity['state']; completedAt: number } & Partial<Pick<
    AgentToolActivity,
    'resultSummary' | 'diff' | 'path' | 'terminalId' | 'error'
  >>;
  effects: AgentEffect[];
}

export interface IrisAgentToolHostOptions {
  projectRoot: string;
  artifactRoot: string;
  commandShell: AgentCommandShell;
  displayThresholdMs?: number;
}

export class IrisAgentToolHost {
  constructor(private readonly options: IrisAgentToolHostOptions) {}

  async execute(
    input: AgentToolOperationInput,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'turnId' | 'toolCallId' | 'operationId'>>,
  ): Promise<IrisAgentToolHostResult> {
    const started = Date.now();
    try {
      const executed = await this.executeUnchecked(input, correlation, started);
      return {
        result: executed.result,
        effects: executed.effects,
        update: {
          ...executed.update,
          state: 'completed',
          completedAt: Date.now(),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        result: { kind: 'void' },
        effects: [],
        update: {
          state: 'failed',
          completedAt: Date.now(),
          error: message,
        },
      };
    }
  }

  private async executeUnchecked(
    input: AgentToolOperationInput,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'turnId' | 'toolCallId' | 'operationId'>>,
    started: number,
  ): Promise<{
    result: AgentToolOperationResult;
    update: Partial<Pick<AgentToolActivity, 'resultSummary' | 'diff' | 'path' | 'terminalId'>>;
    effects: AgentEffect[];
  }> {
    if (input.tool === 'terminal') return this.executeTerminal(input, correlation);

    const target = await this.resolveOperationPath(input.absolutePath);
    const relPath = toProjectPath(relative(this.options.projectRoot, target));
    if (input.operation === 'access') {
      await fs.access(target);
      return {
        result: { kind: 'void' },
        update: { path: relPath, resultSummary: 'access ok' },
        effects: [],
      };
    }
    if (input.operation === 'readFile') {
      const bytes = await fs.readFile(target);
      return {
        result: { kind: 'file', contentBase64: bytes.toString('base64') },
        update: {
          path: relPath,
          resultSummary: String(bytes.byteLength) + ' bytes',
        },
        effects: [],
      };
    }
    if (input.operation === 'mkdir') {
      const existed = await fs.access(target).then(() => true, () => false);
      const effectId = `directory--${correlation.operationId}`;
      const artifactRef = `effects/${effectId}.json`;
      if (!existed) {
        await writeFileAtomic(join(this.options.artifactRoot, ...artifactRef.split('/')), JSON.stringify({
          path: relPath,
          operation: 'mkdir',
        }, null, 2) + '\n');
      }
      await fs.mkdir(target, { recursive: true });
      const effects = existed ? [] : [{
        id: effectId,
        turnId: correlation.turnId,
        toolActivityId: correlation.toolCallId,
        kind: 'directory-create',
        path: relPath,
        artifactRef,
        createdAt: started,
      } satisfies AgentDirectoryEffect];
      return {
        result: { kind: 'void' },
        update: { path: relPath, resultSummary: 'directory ready' },
        effects,
      };
    }

    if (
      !(
        (input.tool === 'edit' && input.operation === 'writeFile') ||
        (input.tool === 'write' && input.operation === 'writeFile')
      )
    ) {
      throw new Error('Unsupported Iris Agent file operation.');
    }
    const content = input.content ?? '';
    const before = await fs.readFile(target, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (before === null && isIrisManagedPath(relPath)) {
      throw new Error('Iris Agent cannot create new .iris documents without an explicit user request.');
    }
    await this.assertWritableParent(target);
    if (before === content) {
      return {
        result: { kind: 'void' },
        update: { path: relPath, resultSummary: 'unchanged' },
        effects: [],
      };
    }
    const beforeSha = before === null ? null : sha256(before);
    const afterSha = sha256(content);
    const kind = input.tool === 'edit' ? 'edit' : 'write';
    const diff = generateUnifiedPatch(relPath, before ?? '', content);
    const effectId = `file--${correlation.operationId}`;
    const artifactRef = `effects/${effectId}.json`;
    await writeFileAtomic(join(this.options.artifactRoot, ...artifactRef.split('/')), JSON.stringify({
      path: relPath,
      operation: kind,
      beforeContent: before,
      afterContent: content,
      beforeSha256: beforeSha,
      afterSha256: afterSha,
    }, null, 2) + '\n');
    await writeFileAtomic(target, content);
    return {
      result: { kind: 'void' },
      update: {
        path: relPath,
        resultSummary: before === null ? 'created' : 'updated',
        diff,
      },
      effects: [{
        id: effectId,
        turnId: correlation.turnId,
        toolActivityId: correlation.toolCallId,
        kind: 'file-write',
        path: relPath,
        operation: kind,
        beforeSha256: beforeSha,
        afterSha256: afterSha,
        artifactRef,
        createdAt: started,
      } satisfies AgentFileEffect],
    };
  }

  private async executeTerminal(
    input: Extract<AgentToolOperationInput, { tool: 'terminal' }>,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'turnId' | 'toolCallId' | 'operationId'>>,
  ): Promise<{
    result: AgentToolOperationResult;
    update: Pick<AgentToolActivity, 'resultSummary' | 'path' | 'terminalId'>;
    effects: AgentEffect[];
  }> {
    if (looksInteractive(input.command)) {
      throw new Error('Interactive terminal commands are not supported in this Iris Agent milestone.');
    }
    const cwd = await this.resolveOperationPath(input.cwd);
    const terminalId = randomUUID();
    const outputPath = join(
      this.options.artifactRoot,
      'terminal',
      terminalId + '.log',
    );
    const pty = new AgentCommandPty({
      terminalId,
      command: input.command,
      cwd,
      outputPath,
      env: sanitizeEnv(input.env),
      commandShell: this.options.commandShell,
      displayThresholdMs: this.options.displayThresholdMs ?? 3000,
    });
    const timeoutMs = Math.min(Math.max(input.timeout ?? 3000, 1), 3000);
    const timeout = setTimeout(() => pty.abort(), timeoutMs);
    const result = await pty.result.finally(() => clearTimeout(timeout));
    const bytes = await fs.readFile(result.outputPath).catch(() => Buffer.alloc(0));
    const relCwd = toProjectPath(relative(this.options.projectRoot, cwd));
    return {
      result: {
        kind: 'terminal',
        exitCode: result.exitCode,
        outputBase64: bytes.toString('base64'),
        terminalId,
        outputPath: result.outputPath,
        shown: result.shown,
      },
      update: {
        terminalId,
        path: relCwd || '.',
        resultSummary: this.options.commandShell.displayName +
          ' (' + this.options.commandShell.executable + '): exit ' +
          String(result.exitCode) + ', ' + String(result.outputBytes) + ' bytes',
      },
      effects: [{
        id: `terminal--${correlation.operationId}`,
        turnId: correlation.turnId,
        toolActivityId: correlation.toolCallId,
        kind: 'terminal-output',
        artifactRef: `terminal/${terminalId}.log`,
        createdAt: Date.now(),
      } satisfies AgentTerminalEffect],
    };
  }

  private async resolveOperationPath(path: string): Promise<string> {
    const absolute = normalize(resolve(this.options.projectRoot, path));
    assertInside(this.options.projectRoot, absolute);
    const metadata = await fs.lstat(absolute).catch(() => null);
    if (metadata?.isSymbolicLink()) {
      assertInside(this.options.projectRoot, normalize(await fs.realpath(absolute)));
    }
    return absolute;
  }

  private async assertWritableParent(path: string): Promise<void> {
    const parent = dirname(path);
    assertInside(this.options.projectRoot, parent);
    const realParent = await fs.realpath(parent);
    assertInside(this.options.projectRoot, normalize(realParent));
  }
}

function assertInside(root: string, target: string): void {
  const normalizedRoot = normalize(root);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
    throw new Error('Iris Agent tool path is outside the active project.');
  }
}

function looksInteractive(command: string): boolean {
  return /\b(read-host|pause|vim|nvim|nano|less|more|ssh|python|node|irb|rails console)\b/i.test(command.trim());
}

function sanitizeEnv(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  if (!env) return process.env;
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') sanitized[key] = value;
  }
  return { ...process.env, ...sanitized };
}

function isIrisManagedPath(path: string): boolean {
  return path === '.iris' || path.startsWith('.iris/');
}

function toProjectPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
