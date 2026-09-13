import type { JtpInvokeRequest, JtpResponse } from './protocol';

export interface JtpExecutionContext {
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface JtpProvider {
  invoke(request: JtpInvokeRequest, context: JtpExecutionContext): Promise<JtpResponse>;
  cancel?(callId: string): Promise<void>;
  close?(): Promise<void>;
}
