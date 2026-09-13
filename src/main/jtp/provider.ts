import type { JtpInvokeRequest, JtpResponse } from './protocol';

export interface JtpExecutionContext {
  signal: AbortSignal;
  timeoutMs?: number;
  /** Host-owned metadata (session/correlation); never part of the wire request. */
  metadata?: Record<string, unknown>;
}

export interface JtpProvider {
  invoke(request: JtpInvokeRequest, context: JtpExecutionContext): Promise<JtpResponse>;
  cancel?(callId: string): Promise<void>;
  close?(): Promise<void>;
}
