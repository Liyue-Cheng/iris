export type JtpEffect = 'read' | 'write' | 'external';
export type JtpErrorKind = 'validation' | 'unavailable' | 'execution' | 'timeout' | 'canceled' | 'protocol';

export interface JtpInvokeRequest {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface JtpError {
  kind: JtpErrorKind;
  code: string;
  message: string;
  retryable: boolean;
}

export type JtpResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: JtpError };

export type JtpEvent =
  | { type: 'started'; id: string; tool: string; at: number }
  | { type: 'completed'; id: string; tool: string; at: number; response: JtpResponse }
  | { type: 'failed'; id: string; tool: string; at: number; error: JtpError };
