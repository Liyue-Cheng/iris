import type { IrisAgentImageMimeType } from './types';

export type JtpEffect = 'read' | 'write' | 'external';
export type JtpErrorKind = 'validation' | 'unavailable' | 'execution' | 'timeout' | 'canceled' | 'protocol';

export interface JtpInvokeRequest {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export type JtpBuiltinInput =
  | { tool: 'read'; operation: 'access' | 'readFile'; absolutePath: string; offset?: number; limit?: number }
  | { tool: 'edit'; operation: 'access' | 'readFile' | 'writeFile'; absolutePath: string; edits?: Array<{ oldText: string; newText: string }> }
  | { tool: 'write'; operation: 'mkdir' | 'writeFile'; absolutePath: string; content?: string }
  | { tool: 'terminal'; operation: 'exec'; command: string; intent: 'information' | 'operation'; timeout: number; cwd: string; successExitCodes?: number[]; env?: Record<string, string | undefined> }
  | { tool: 'task_start'; operation: 'start'; command: string; title: string; successExitCodes?: number[] }
  | { tool: 'task_get'; operation: 'get'; taskId: string; cursor?: string; maxBytes?: number }
  | { tool: 'task_list'; operation: 'list'; scope?: 'active' | 'all'; cursor?: string; limit?: number }
  | { tool: 'task_cancel'; operation: 'cancel'; taskId: string };

export interface JtpError {
  kind: JtpErrorKind;
  code: string;
  message: string;
  retryable: boolean;
}

export type JtpResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: JtpError };

/** Built-in provider result vocabulary. External providers may return any JSON value. */
export type JtpBuiltinResult =
  | { kind: 'void'; message?: string }
  | { kind: 'file'; contentBase64: string }
  | { kind: 'image'; mimeType: IrisAgentImageMimeType; contentBase64: string; bytes: number; width?: number; height?: number }
  | { kind: 'terminal'; exitCode: number | null; success: boolean; outputText: string; outputTruncated: boolean; terminalId: string; outputPath: string; shown: boolean; termination?: 'natural' | 'timeout' | 'aborted' }
  | { kind: 'task'; taskId?: string; status?: 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'lost'; outputText: string; outputTruncated?: boolean; logRef?: string };

export type JtpEvent =
  | { type: 'started'; id: string; tool: string; at: number }
  | { type: 'completed'; id: string; tool: string; at: number; response: JtpResponse }
  | { type: 'failed'; id: string; tool: string; at: number; error: JtpError };
