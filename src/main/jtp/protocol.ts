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
