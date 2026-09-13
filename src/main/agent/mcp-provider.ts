import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export interface JtpMcpServerConfig {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface JtpMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface JtpMcpResult {
  ok: boolean;
  result?: unknown;
  error?: { kind: 'unavailable' | 'execution' | 'protocol'; code: string; message: string; retryable: boolean };
}

/** Minimal MCP stdio bridge. MCP stays entirely behind this provider boundary. */
export class JtpMcpProvider {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(private readonly config: JtpMcpServerConfig) {}

  async connect(): Promise<void> {
    if (this.process) return;
    this.process = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const child = this.process;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.on('error', (error) => this.failPending(error));
    child.on('exit', () => this.failPending(new Error('MCP server exited')));
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'iris-jtp', version: '0.1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  }

  async listTools(): Promise<JtpMcpTool[]> {
    await this.connect();
    const response = await this.request('tools/list', {});
    const tools = response?.tools;
    return Array.isArray(tools) ? tools.filter((tool): tool is JtpMcpTool => Boolean(tool && typeof tool.name === 'string')) : [];
  }

  async invoke(tool: string, arguments_: Record<string, unknown>): Promise<JtpMcpResult> {
    try {
      await this.connect();
      const result = await this.request('tools/call', { name: tool, arguments: arguments_ });
      return { ok: !result?.isError, result };
    } catch (error) {
      return { ok: false, error: { kind: 'execution', code: 'MCP_CALL_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false } };
    }
  }

  close(): void {
    this.process?.kill();
    this.process = null;
    this.failPending(new Error('MCP provider closed'));
  }

  private request(method: string, params: unknown): Promise<any> {
    const child = this.process;
    if (!child) return Promise.reject(new Error('MCP provider is not connected'));
    const id = ++this.nextId;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private handleLine(line: string): void {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message?.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? 'MCP protocol error'));
    else pending.resolve(message.result);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function mcpJtpToolId(serverId: string, toolName: string): string {
  return `mcp.${serverId}.${toolName}`;
}

export function mcpCallId(): string { return randomUUID(); }
