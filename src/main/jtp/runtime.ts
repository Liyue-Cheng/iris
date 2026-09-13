import type { JtpInvokeRequest, JtpResponse } from './protocol';
import type { JtpRegistry } from './registry';
import { Value } from 'typebox/value';
import type { JtpEvent } from './protocol';

export class JtpRuntime {
  private readonly completed = new Set<string>();
  private readonly listeners = new Set<(event: JtpEvent) => void>();
  constructor(private readonly registry: JtpRegistry) {}

  tools() { return this.registry.modelTools(); }
  subscribe(listener: (event: JtpEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: JtpEvent): void { for (const listener of this.listeners) listener(event); }

  async invoke(request: JtpInvokeRequest, signal = new AbortController().signal): Promise<JtpResponse> {
    if (!request.id || !request.tool || !request.arguments || typeof request.arguments !== 'object') return { id: request.id ?? '', ok: false, error: { kind: 'protocol', code: 'INVALID_REQUEST', message: 'Invalid JTP request.', retryable: false } };
    if (this.completed.has(request.id)) return { id: request.id, ok: false, error: { kind: 'protocol', code: 'DUPLICATE_CALL', message: 'Call ID has already completed.', retryable: false } };
    const descriptor = this.registry.descriptor(request.tool);
    const provider = this.registry.provider(request.tool);
    if (!descriptor || !provider) return { id: request.id, ok: false, error: { kind: 'unavailable', code: 'UNKNOWN_TOOL', message: `Unknown tool: ${request.tool}`, retryable: false } };
    if (!this.registry.isEnabled(request.tool)) return { id: request.id, ok: false, error: { kind: 'unavailable', code: 'TOOL_DISABLED', message: `Tool is disabled: ${request.tool}`, retryable: false } };
    if (!Value.Check(descriptor.inputSchema as never, request.arguments)) {
      return { id: request.id, ok: false, error: { kind: 'validation', code: 'INVALID_ARGUMENTS', message: `Arguments do not match the schema for ${request.tool}.`, retryable: false } };
    }
    this.emit({ type: 'started', id: request.id, tool: request.tool, at: Date.now() });
    try {
      const response = await provider.invoke(request, { signal });
      this.completed.add(request.id);
      if (response.ok) this.emit({ type: 'completed', id: request.id, tool: request.tool, at: Date.now(), response });
      else this.emit({ type: 'failed', id: request.id, tool: request.tool, at: Date.now(), error: response.error });
      return response;
    } catch (error) {
      this.completed.add(request.id);
      const response = { id: request.id, ok: false as const, error: { kind: signal.aborted ? 'canceled' as const : 'execution' as const, code: signal.aborted ? 'CANCELED' : 'PROVIDER_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false } };
      this.emit({ type: 'failed', id: request.id, tool: request.tool, at: Date.now(), error: response.error });
      return response;
    }
  }
}
