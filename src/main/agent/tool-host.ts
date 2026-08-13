import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { AgentCommandPty } from './command-pty';
import { writeFileAtomic } from '../atomic-write';
import type {
  AgentCorrelation,
  AgentToolOperationInput,
  AgentToolOperationResult,
} from '@shared/agent-protocol';
import type {
  IrisAgentFileEffect,
  IrisAgentToolEvent,
} from '@shared/types';

export interface IrisAgentToolHostResult {
  result: AgentToolOperationResult;
  event: IrisAgentToolEvent;
  fileEffect?: IrisAgentFileEffect;
}

export interface IrisAgentToolHostOptions {
  projectRoot: string;
  outputRoot: string;
  displayThresholdMs?: number;
}

export class IrisAgentToolHost {
  constructor(private readonly options: IrisAgentToolHostOptions) {}

  async execute(
    input: AgentToolOperationInput,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'requestId' | 'turnId' | 'toolCallId'>>,
  ): Promise<IrisAgentToolHostResult> {
    const started = Date.now();
    const eventBase = {
      id: correlation.toolCallId,
      turnId: correlation.turnId,
      requestId: correlation.requestId,
      createdAt: started,
      inputSummary: summarizeInput(input),
    };
    try {
      const executed = await this.executeUnchecked(input, correlation, started);
      return {
        ...executed,
        event: {
          ...eventBase,
          ...executed.event,
          state: 'completed',
          completedAt: Date.now(),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        result: { kind: 'void' },
        event: {
          ...eventBase,
          name: input.tool,
          state: 'failed',
          completedAt: Date.now(),
          error: message,
        },
      };
    }
  }

  private async executeUnchecked(
    input: AgentToolOperationInput,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'requestId' | 'turnId' | 'toolCallId'>>,
    started: number,
  ): Promise<{
    result: AgentToolOperationResult;
    event: Pick<IrisAgentToolEvent, 'name' | 'resultSummary' | 'diff' | 'path' | 'terminalId'>;
    fileEffect?: IrisAgentFileEffect;
  }> {
    if (input.tool === 'terminal') return this.executeTerminal(input, correlation);

    const target = await this.resolveOperationPath(input.absolutePath);
    const relPath = toProjectPath(relative(this.options.projectRoot, target));
    if (input.operation === 'access') {
      await fs.access(target);
      return {
        result: { kind: 'void' },
        event: { name: input.tool, path: relPath, resultSummary: 'access ok' },
      };
    }
    if (input.operation === 'readFile') {
      const bytes = await fs.readFile(target);
      return {
        result: { kind: 'file', contentBase64: bytes.toString('base64') },
        event: {
          name: input.tool,
          path: relPath,
          resultSummary: String(bytes.byteLength) + ' bytes',
        },
      };
    }
    if (input.operation === 'mkdir') {
      await this.assertWritableParent(target);
      await fs.mkdir(target, { recursive: true });
      return {
        result: { kind: 'void' },
        event: { name: input.tool, path: relPath, resultSummary: 'directory ready' },
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
    await this.assertWritableParent(target);
    const before = await fs.readFile(target, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (before === null && isIrisManagedPath(relPath)) {
      throw new Error('Iris Agent cannot create new .iris documents without an explicit user request.');
    }
    if (before === content) {
      return {
        result: { kind: 'void' },
        event: { name: input.tool, path: relPath, resultSummary: 'unchanged' },
      };
    }
    await writeFileAtomic(target, content);
    const beforeSha = before === null ? null : sha256(before);
    const afterSha = sha256(content);
    const kind = input.tool === 'edit' ? 'edit' : 'write';
    const diff = summarizeDiff(before, content, relPath);
    return {
      result: { kind: 'void' },
      event: {
        name: input.tool,
        path: relPath,
        resultSummary: before === null ? 'created' : 'updated',
        diff,
      },
      fileEffect: {
        id: randomUUID(),
        turnId: correlation.turnId,
        toolCallId: correlation.toolCallId,
        path: relPath,
        kind,
        beforeSha256: beforeSha,
        afterSha256: afterSha,
        ...(before === null ? {} : { beforeContent: before }),
        afterContent: content,
        createdAt: started,
      },
    };
  }

  private async executeTerminal(
    input: Extract<AgentToolOperationInput, { tool: 'terminal' }>,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'requestId' | 'turnId' | 'toolCallId'>>,
  ): Promise<{
    result: AgentToolOperationResult;
    event: Pick<IrisAgentToolEvent, 'name' | 'resultSummary' | 'path' | 'terminalId'>;
  }> {
    if (looksInteractive(input.command)) {
      throw new Error('Interactive terminal commands are not supported in this Iris Agent milestone.');
    }
    const cwd = await this.resolveOperationPath(input.cwd);
    const terminalId = randomUUID();
    const outputPath = join(
      this.options.outputRoot,
      correlation.sessionId,
      'terminal',
      terminalId + '.log',
    );
    const pty = new AgentCommandPty({
      terminalId,
      command: input.command,
      cwd,
      outputPath,
      env: sanitizeEnv(input.env),
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
      event: {
        name: 'terminal',
        terminalId,
        path: relCwd || '.',
        resultSummary: 'exit ' + String(result.exitCode) + ', ' + String(result.outputBytes) + ' bytes',
      },
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
    await fs.mkdir(parent, { recursive: true });
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

function summarizeInput(input: AgentToolOperationInput): string {
  if (input.tool === 'terminal') return input.command.slice(0, 220);
  return (input.operation + ' ' + input.absolutePath).slice(0, 220);
}

function summarizeDiff(before: string | null, after: string, path: string): string {
  if (before === null) return 'created ' + path + ' (' + String(after.length) + ' chars)';
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let first = 0;
  while (first < beforeLines.length && first < afterLines.length && beforeLines[first] === afterLines[first]) {
    first += 1;
  }
  return 'updated ' + path + ' at line ' + String(first + 1) + ' (' + String(before.length) + ' -> ' + String(after.length) + ' chars)';
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
