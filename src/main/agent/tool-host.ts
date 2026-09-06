import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';
import {
  AgentCommandPty,
  type AgentCommandPtyEvent,
  type AgentCommandPtyOptions,
} from './command-pty';
import { writeFileAtomic } from '../atomic-write';
import type {
  AgentCommandShell,
  AgentCorrelation,
  AgentToolOperationInput,
  AgentToolOperationResult,
} from '@shared/agent-protocol';
import type { AgentToolActivity } from './session-model';

export interface IrisAgentToolHostResult {
  result: AgentToolOperationResult;
  update: { state: AgentToolActivity['state']; completedAt: number } & Partial<Pick<
    AgentToolActivity,
    'resultSummary' | 'diff' | 'path' | 'terminalId' | 'error' |
    'terminalState' | 'terminalOutcome' | 'terminalStartedAt' |
    'terminalCompletedAt' | 'terminalExitCode' | 'terminalSuccessExitCodes' |
    'terminalOutputBytes' | 'terminalOutputPreview'
  >>;
}

export interface IrisAgentToolHostOptions {
  projectRoot: string;
  commandShell: AgentCommandShell;
  displayThresholdMs?: number;
  terminalFactory?: (options: AgentCommandPtyOptions) => AgentCommandPty;
  onTerminalCreated?: (
    terminal: AgentCommandPty,
    context: { terminalId: string; correlation: AgentCorrelation; outputPath: string },
  ) => void;
  onTerminalEvent?: (
    event: AgentCommandPtyEvent,
    context: { correlation: AgentCorrelation; outputPath: string },
  ) => void;
}

export class IrisAgentToolHost {
  constructor(private readonly options: IrisAgentToolHostOptions) {}

  async execute(
    input: AgentToolOperationInput,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'intentId' | 'turnId' | 'toolCallId' | 'operationId'>>,
  ): Promise<IrisAgentToolHostResult> {
    const started = Date.now();
    try {
      const executed = await this.executeUnchecked(input, correlation, started);
      const terminalExitCode = executed.result.kind === 'terminal' ? executed.result.exitCode : null;
      const terminalFailed = executed.result.kind === 'terminal' && !executed.result.success;
      return {
        result: executed.result,
        update: {
          ...executed.update,
          state: terminalFailed ? 'failed' : 'completed',
          completedAt: Date.now(),
          ...(terminalFailed
            ? { error: `Command exited with code ${String(terminalExitCode)}.` }
            : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const completedAt = Date.now();
      return {
        result: { kind: 'void' },
        update: {
          state: 'failed',
          completedAt,
          error: message,
          ...(input.tool === 'terminal'
            ? {
                terminalState: 'exited' as const,
                terminalOutcome: 'launch-failed' as const,
                terminalStartedAt: started,
                terminalCompletedAt: completedAt,
              }
            : {}),
        },
      };
    }
  }

  private async executeUnchecked(
    input: AgentToolOperationInput,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'intentId' | 'turnId' | 'toolCallId' | 'operationId'>>,
    started: number,
  ): Promise<{
    result: AgentToolOperationResult;
    update: Partial<Pick<AgentToolActivity, 'resultSummary' | 'diff' | 'path' | 'terminalId'>>;
  }> {
    if (input.tool === 'terminal') return this.executeTerminal(input, correlation, started);

    const target = this.resolveUnrestrictedPath(input.absolutePath);
    const relPath = toProjectPath(relative(this.options.projectRoot, target));
    if (input.operation === 'access') {
      await fs.access(target);
      return {
        result: { kind: 'void' },
        update: { path: relPath, resultSummary: 'access ok' },
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
      };
    }
    if (input.operation === 'mkdir') {
      await fs.mkdir(target, { recursive: true });
      return {
        result: { kind: 'void' },
        update: { path: relPath, resultSummary: 'directory ready' },
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
    if (before === content) {
      return {
        result: { kind: 'void' },
        update: { path: relPath, resultSummary: 'unchanged' },
      };
    }
    const diff = generateUnifiedPatch(relPath, before ?? '', content);
    await writeFileAtomic(target, content);
    return {
      result: { kind: 'void' },
      update: {
        path: relPath,
        resultSummary: before === null ? 'created' : 'updated',
        diff,
      },
    };
  }

  private async executeTerminal(
    input: Extract<AgentToolOperationInput, { tool: 'terminal' }>,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'intentId' | 'turnId' | 'toolCallId' | 'operationId'>>,
    started: number,
  ): Promise<{
    result: AgentToolOperationResult;
    update: Pick<
      AgentToolActivity,
      'path' | 'terminalId' | 'terminalState' |
      'terminalOutcome' | 'terminalStartedAt' | 'terminalCompletedAt' | 'terminalExitCode' |
      'terminalSuccessExitCodes' | 'terminalOutputBytes' | 'terminalOutputPreview'
    >;
  }> {
    const cwd = this.resolveUnrestrictedPath(input.cwd);
    const terminalId = randomUUID();
    const outputPath = join(tmpdir(), 'iris-agent-terminals', terminalId + '.log');
    const terminalOptions: AgentCommandPtyOptions = {
      terminalId,
      command: input.command,
      cwd,
      outputPath,
      env: sanitizeEnv(input.env),
      commandShell: this.options.commandShell,
      displayThresholdMs: this.options.displayThresholdMs ?? 3000,
      onEvent: (event) => this.options.onTerminalEvent?.(event, { correlation, outputPath }),
    };
    const pty = this.options.terminalFactory?.(terminalOptions) ??
      new AgentCommandPty(terminalOptions);
    this.options.onTerminalCreated?.(pty, { terminalId, correlation, outputPath });
    const result = await pty.result;
    const relCwd = toProjectPath(relative(this.options.projectRoot, cwd));
    const outputText = tailText(result.plainText, 64 * 1024);
    const successExitCodes = normalizeSuccessExitCodes(input.successExitCodes);
    const success = successExitCodes.includes(result.exitCode);
    return {
      result: {
        kind: 'terminal',
        exitCode: result.exitCode,
        success,
        outputText: outputText.text,
        outputTruncated: outputText.truncated || result.outputTruncated || result.outputBytes > 64 * 1024,
        terminalId,
        outputPath: result.outputPath,
        shown: result.shown,
      },
      update: {
        terminalId,
        path: relCwd || '.',
        terminalState: 'exited',
        terminalOutcome: success ? 'success' : 'command-failed',
        terminalStartedAt: started,
        terminalCompletedAt: Date.now(),
        terminalExitCode: result.exitCode,
        terminalSuccessExitCodes: successExitCodes,
        terminalOutputBytes: result.outputBytes,
        terminalOutputPreview: tailText(result.plainText, 8 * 1024).text,
      },
    };
  }

  private resolveUnrestrictedPath(path: string): string {
    return normalize(resolve(this.options.projectRoot, path));
  }
}

function generateUnifiedPatch(path: string, before: string, after: string): string {
  const oldLines = before.split(/\r?\n/u);
  const newLines = after.split(/\r?\n/u);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) { oldEnd -= 1; newEnd -= 1; }
  const removed = oldLines.slice(start, oldEnd + 1).map((line) => `-${line}`);
  const added = newLines.slice(start, newEnd + 1).map((line) => `+${line}`);
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${start + 1},${Math.max(0, oldEnd - start + 1)} +${start + 1},${Math.max(0, newEnd - start + 1)} @@`, ...removed, ...added].join('\n');
}

function sanitizeEnv(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  if (!env) return process.env;
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') sanitized[key] = value;
  }
  return { ...process.env, ...sanitized };
}

function tailText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return {
    text: bytes.subarray(start).toString('utf8'),
    truncated: true,
  };
}

function normalizeSuccessExitCodes(value: number[] | undefined): number[] {
  const normalized = value?.filter((code) => Number.isSafeInteger(code)) ?? [];
  return normalized.length > 0 ? [...new Set(normalized)] : [0];
}

function toProjectPath(path: string): string {
  return path.replaceAll('\\', '/');
}
