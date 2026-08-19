import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn, type IDisposable, type IPty } from 'node-pty';
import type { AgentCommandShell } from '@shared/agent-protocol';
import { buildSpawnEnv } from '../pty-utils';

export interface AgentCommandPtyResult {
  terminalId: string;
  exitCode: number;
  signal?: number;
  outputPath: string;
  outputBytes: number;
  finalCursor: number;
  shown: boolean;
}

export interface AgentCommandPtyEvent {
  type: 'output' | 'shown' | 'completed';
  terminalId: string;
  cursor?: number;
  data?: string;
  result?: AgentCommandPtyResult;
}

export interface AgentCommandOutputStore {
  append(path: string, bytes: Buffer): Promise<void>;
}

export interface AgentCommandPtyOptions {
  terminalId: string;
  command: string;
  cwd: string;
  outputPath: string;
  env?: NodeJS.ProcessEnv;
  commandShell?: AgentCommandShell;
  displayThresholdMs?: number;
  spawnFn?: typeof spawn;
  outputStore?: AgentCommandOutputStore;
  onEvent?: (event: AgentCommandPtyEvent) => void;
}

export class AgentCommandPty {
  private readonly pty: IPty;
  private readonly disposables: IDisposable[] = [];
  private readonly displayTimer: ReturnType<typeof setTimeout>;
  private outputChain = Promise.resolve();
  private cursor = 0;
  private shown = false;
  private settled = false;
  private resolveResult!: (result: AgentCommandPtyResult) => void;
  private rejectResult!: (error: Error) => void;
  readonly result: Promise<AgentCommandPtyResult>;

  constructor(private readonly options: AgentCommandPtyOptions) {
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    const env = buildSpawnEnv(options.env ?? process.env, [
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_RENDERER_URL',
      'FOCUS_DOC',
      'IRIS_WORKSPACE_PATH',
    ]);
    const shell = commandShell(options.command, env, process.platform, options.commandShell);
    this.pty = (options.spawnFn ?? spawn)(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: options.cwd,
      env,
      encoding: null,
    });
    this.displayTimer = setTimeout(
      () => this.show(),
      options.displayThresholdMs ?? 3_000,
    );
    this.disposables.push(
      this.pty.onData((data) => this.acceptOutput(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))),
      this.pty.onExit((event) => void this.finish(event.exitCode, event.signal)),
    );
  }

  abort(): void {
    if (!this.settled) this.pty.kill();
  }

  private acceptOutput(bytes: Buffer): void {
    if (this.settled) return;
    const startCursor = this.cursor;
    this.cursor += bytes.length;
    const store = this.options.outputStore ?? fileOutputStore;
    this.outputChain = this.outputChain.then(() => store.append(this.options.outputPath, bytes));
    this.options.onEvent?.({
      type: 'output',
      terminalId: this.options.terminalId,
      cursor: startCursor,
      data: bytes.toString('base64'),
    });
  }

  private show(): void {
    if (this.settled || this.shown) return;
    this.shown = true;
    this.options.onEvent?.({ type: 'shown', terminalId: this.options.terminalId });
  }

  private async finish(exitCode: number, signal?: number): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.displayTimer);
    for (const disposable of this.disposables) disposable.dispose();
    try {
      await this.outputChain;
    } catch (error) {
      this.rejectResult(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const result: AgentCommandPtyResult = {
      terminalId: this.options.terminalId,
      exitCode,
      ...(signal === undefined ? {} : { signal }),
      outputPath: this.options.outputPath,
      outputBytes: this.cursor,
      finalCursor: this.cursor,
      shown: this.shown,
    };
    this.options.onEvent?.({ type: 'completed', terminalId: this.options.terminalId, result });
    this.resolveResult(result);
  }
}

export function commandShell(
  command: string,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  resolvedShell: AgentCommandShell = resolveAgentCommandShell(env, platform),
): { file: string; args: string[] } {
  if (resolvedShell.kind === 'powershell') {
    return {
      file: resolvedShell.executable,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  return { file: resolvedShell.executable, args: ['-lc', command] };
}

export function resolveAgentCommandShell(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
): AgentCommandShell {
  if (platform !== 'win32') {
    const executable = env.SHELL || '/bin/bash';
    return { kind: 'posix', executable, displayName: executable };
  }

  const pathDirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const hasPwsh = pathDirs.some((directory) =>
    fileExists(`${directory.replace(/[\\/]+$/u, '')}\\pwsh.exe`));
  return hasPwsh
    ? { kind: 'powershell', executable: 'pwsh.exe', displayName: 'PowerShell 7' }
    : {
        kind: 'powershell',
        executable: 'powershell.exe',
        displayName: 'Windows PowerShell',
      };
}

const fileOutputStore: AgentCommandOutputStore = {
  async append(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, bytes);
  },
};
