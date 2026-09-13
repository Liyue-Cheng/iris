import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';
import {
  AgentCommandPty,
  AGENT_TERMINAL_MAX_TIMEOUT_SECONDS,
  type AgentCommandPtyEvent,
  type AgentCommandPtyOptions,
} from '../agent/command-pty';
import { writeFileAtomic } from '../atomic-write';
import type {
  AgentCommandShell,
  AgentCorrelation,
  JtpBuiltinInput,
  JtpBuiltinResult,
} from '@shared/agent-protocol';
import type { AgentToolActivity } from '../agent/session-model';
import { applyTextEdits, type TextEdit } from '../agent/edit-diff';
import { defaultProcessTreeKiller } from '../terminal/process-tree';
import { detectImageBytes, readImageSize } from '@shared/image-signature';
import { AGENT_IMAGE_MAX_BYTES } from '@shared/agent-protocol';

/**
 * Largest image the Agent will hand to a provider. Deliberately below the
 * document asset ceiling: an image read here is re-sent on every request that
 * still carries it, so the limit is about context cost, not disk.
 */
export const AGENT_READ_IMAGE_MAX_BYTES = AGENT_IMAGE_MAX_BYTES;

export interface JtpNativeExecutionResult {
  result: JtpBuiltinResult;
  update: { state: AgentToolActivity['state']; completedAt: number } & Partial<Pick<
    AgentToolActivity,
    'resultSummary' | 'diff' | 'path' | 'terminalId' | 'error' |
    'terminalState' | 'terminalOutcome' | 'terminalStartedAt' |
    'terminalCompletedAt' | 'terminalExitCode' | 'terminalSuccessExitCodes' |
    'terminalOutputBytes' | 'terminalOutputPreview'
    | 'taskId' | 'taskStatus'
  >>;
}

export interface JtpNativeExecutionOptions {
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

export class JtpNativeExecution {
  constructor(private readonly options: JtpNativeExecutionOptions) {}

  async execute(
    input: JtpBuiltinInput,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'intentId' | 'turnId' | 'toolCallId' | 'operationId'>>,
  ): Promise<JtpNativeExecutionResult> {
    const started = Date.now();
    try {
      const executed = await this.executeUnchecked(input, correlation, started);
      const terminalExitCode = executed.result.kind === 'terminal' ? executed.result.exitCode : null;
      const terminalFailed = executed.result.kind === 'terminal' &&
        (!executed.result.success || executed.result.termination === 'timeout' || executed.result.termination === 'aborted');
      return {
        result: executed.result,
        update: {
          ...executed.update,
          state: terminalFailed ? 'failed' : 'completed',
          completedAt: Date.now(),
          ...(terminalFailed
            ? {
                error: executed.result.kind === 'terminal' && executed.result.termination === 'timeout'
                  ? `Command timed out after ${String(input.tool === 'terminal' ? input.timeout : '')} seconds.`
                  : `Command exited with code ${String(terminalExitCode)}.`,
              }
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
    input: JtpBuiltinInput,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'intentId' | 'turnId' | 'toolCallId' | 'operationId'>>,
    started: number,
  ): Promise<{
    result: JtpBuiltinResult;
    update: Partial<Pick<AgentToolActivity, 'resultSummary' | 'diff' | 'path' | 'terminalId'>>;
  }> {
    if (input.tool === 'terminal') return this.executeTerminal(input, correlation, started);
    if (input.tool === 'task_start' || input.tool === 'task_get' ||
      input.tool === 'task_list' || input.tool === 'task_cancel') {
      throw new Error('Background task operations must be handled by the Task Manager.');
    }

    const target = this.resolveUnrestrictedPath(input.absolutePath);
    const relPath = toProjectPath(relative(this.options.projectRoot, target));
    if (input.operation === 'access') {
      await fs.access(target, input.tool === 'edit' ? constants.R_OK | constants.W_OK : constants.R_OK);
      return {
        result: { kind: 'void' },
        update: { path: relPath, resultSummary: 'access ok' },
      };
    }
    if (input.operation === 'readFile') {
      const bytes = await fs.readFile(target);
      // An image needs no paging: `offset`/`limit` describe text lines, and the
      // model is better served by the pixels than by a base64 slice of them.
      if (input.tool === 'read') {
        const image = readAgentImage(bytes);
        if (image) {
          return {
            result: image,
            update: {
              path: relPath,
              resultSummary: describeImageResult(image),
            },
          };
        }
      }
      const output = input.tool === 'read'
        ? truncateReadBuffer(bytes, input.offset, input.limit)
        : { bytes, truncated: false };
      return {
        result: { kind: 'file', contentBase64: output.bytes.toString('base64') },
        update: {
          path: relPath,
          resultSummary: String(bytes.byteLength) + ' bytes' + (output.truncated ? ' (truncated)' : ''),
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
    if (input.tool === 'edit') {
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        throw new Error('Edit tool requires at least one oldText/newText replacement.');
      }
      const before = await fs.readFile(target, 'utf8');
      const content = applyTextEdits(before, input.edits as TextEdit[], relPath);
      const diff = generateUnifiedPatch(relPath, before, content);
      await writeFileAtomic(target, content);
      return {
        result: { kind: 'void', message: `Successfully replaced ${input.edits.length} block(s) in ${relPath}.` },
        update: { path: relPath, resultSummary: 'updated', diff },
      };
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
      result: { kind: 'void', message: `Successfully wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${relPath}` },
      update: {
        path: relPath,
        resultSummary: before === null ? 'created' : 'updated',
        diff,
      },
    };
  }

  private async executeTerminal(
    input: Extract<JtpBuiltinInput, { tool: 'terminal' }>,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'intentId' | 'turnId' | 'toolCallId' | 'operationId'>>,
    started: number,
  ): Promise<{
    result: JtpBuiltinResult;
    update: Pick<
      AgentToolActivity,
      'path' | 'terminalId' | 'terminalState' |
      'terminalOutcome' | 'terminalStartedAt' | 'terminalCompletedAt' | 'terminalExitCode' |
      'terminalSuccessExitCodes' | 'terminalOutputBytes' | 'terminalOutputPreview'
    >;
  }> {
    const cwd = this.resolveUnrestrictedPath(input.cwd);
    const timeoutSeconds = validateTerminalTimeout(input.timeout);
    const terminalId = randomUUID();
    const outputPath = join(tmpdir(), 'iris-agent-terminals', terminalId + '.log');
    const terminalOptions: AgentCommandPtyOptions = {
      terminalId,
      command: input.command,
      cwd,
      outputPath,
      env: sanitizeEnv(input.env),
      commandShell: this.options.commandShell,
      processTreeKillFn: defaultProcessTreeKiller(),
      displayThresholdMs: this.options.displayThresholdMs ?? 3000,
      timeoutMs: timeoutSeconds * 1000,
      // Foreground terminals are replayed into a dialog, so a mirror nobody has
      // caught up with must be able to slow the command down.
      mirrorBackpressure: true,
      onEvent: (event) => this.options.onTerminalEvent?.(event, { correlation, outputPath }),
    };
    const pty = this.options.terminalFactory?.(terminalOptions) ??
      new AgentCommandPty(terminalOptions);
    this.options.onTerminalCreated?.(pty, { terminalId, correlation, outputPath });
    const result = await pty.result;
    const relCwd = toProjectPath(relative(this.options.projectRoot, cwd));
    const outputText = tailText(result.plainText, 64 * 1024);
    const outputWasTruncated = outputText.truncated || result.outputTruncated || result.outputBytes > 64 * 1024;
    const modelOutput = outputWasTruncated
      ? `${outputText.text}\n\n[Showing the available tail preview; full output is available at ${result.outputPath}.]`
      : outputText.text;
    const successExitCodes = normalizeSuccessExitCodes(input.successExitCodes);
    const success = result.termination === undefined && successExitCodes.includes(result.exitCode);
    return {
      result: {
        kind: 'terminal',
        exitCode: result.exitCode,
        success,
        outputText: modelOutput,
        outputTruncated: outputWasTruncated,
        terminalId,
        outputPath: result.outputPath,
        shown: result.shown,
        ...(result.termination ? { termination: result.termination } : {}),
      },
      update: {
        terminalId,
        path: relCwd || '.',
        terminalState: 'exited',
        terminalOutcome: result.termination === 'timeout'
          ? 'timeout'
          : result.termination === 'aborted'
            ? 'canceled'
            : success ? 'success' : 'command-failed',
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

/**
 * Recognize an image the Agent may send to a provider. Anything unrecognized,
 * unsupported (SVG) or oversized returns null so the caller keeps its text
 * path and the model receives the honest bytes-as-text result instead of a
 * silently truncated image.
 */
function readAgentImage(bytes: Buffer): Extract<JtpBuiltinResult, { kind: 'image' }> | null {
  const detected = detectImageBytes(bytes);
  if (!detected || bytes.byteLength > AGENT_READ_IMAGE_MAX_BYTES) return null;
  const size = readImageSize(bytes, detected.mimeType);
  return {
    kind: 'image',
    mimeType: detected.mimeType,
    contentBase64: bytes.toString('base64'),
    bytes: bytes.byteLength,
    ...(size ?? {}),
  };
}

/** The text half of an image read; the model sees this next to the pixels. */
export function describeImageResult(
  image: Extract<JtpBuiltinResult, { kind: 'image' }>,
): string {
  const dimensions = image.width && image.height ? ` ${String(image.width)}x${String(image.height)}` : '';
  return `${image.mimeType}${dimensions} ${formatByteCount(image.bytes)}`;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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

/** Validate a foreground terminal deadline in protocol seconds. */
export function validateTerminalTimeout(value: number | undefined): number {
  if (value === undefined) {
    throw new Error('Terminal timeout is required.');
  }
  if (!Number.isFinite(value) || value <= 0 || value > AGENT_TERMINAL_MAX_TIMEOUT_SECONDS) {
    throw new Error(`Terminal timeout must be a finite positive value no greater than ${AGENT_TERMINAL_MAX_TIMEOUT_SECONDS} seconds.`);
  }
  return value;
}

function toProjectPath(path: string): string {
  return path.replaceAll('\\', '/');
}

const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50 * 1024;

function truncateReadBuffer(
  bytes: Buffer,
  offset: number | undefined,
  limit: number | undefined,
): { bytes: Buffer; truncated: boolean } {
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  const start = offset === undefined ? 0 : Math.max(0, Math.floor(offset) - 1);
  if (start >= lines.length) {
    throw new Error(`Offset ${String(offset)} is beyond end of file (${lines.length} lines total)`);
  }
  const requestedEnd = limit === undefined ? lines.length : Math.min(lines.length, start + Math.max(0, Math.floor(limit)));
  const maxLines = Math.min(
    READ_MAX_LINES,
    limit === undefined ? READ_MAX_LINES : Math.max(0, Math.floor(limit)),
  );
  const lineLimitedEnd = Math.min(requestedEnd, start + maxLines);
  let output = lines.slice(start, lineLimitedEnd).join('\n');
  let truncated = lineLimitedEnd < requestedEnd || (limit === undefined && lineLimitedEnd < lines.length);
  const outputBytes = Buffer.from(output, 'utf8');
  if (outputBytes.byteLength > READ_MAX_BYTES) {
    let end = READ_MAX_BYTES;
    while (end > 0 && (outputBytes[end]! & 0xc0) === 0x80) end -= 1;
    output = outputBytes.subarray(0, end).toString('utf8');
    truncated = true;
  }
  if (truncated) {
    const shownLines = output.split('\n').length;
    const nextOffset = start + shownLines + 1;
    const suffix = `\n\n[Showing lines ${start + 1}-${start + shownLines} of ${lines.length}. Use offset=${nextOffset} to continue.]`;
    output += suffix;
  } else if (limit !== undefined && requestedEnd < lines.length) {
    output += `\n\n[${lines.length - requestedEnd} more lines in file. Use offset=${requestedEnd + 1} to continue.]`;
  }
  return { bytes: Buffer.from(output, 'utf8'), truncated };
}



