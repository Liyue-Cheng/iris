import type { JtpInvokeRequest, JtpResponse } from './protocol';
import type { JtpRegistry } from './registry';

export class JtpRuntime {
  private readonly completed = new Set<string>();
  constructor(private readonly registry: JtpRegistry) {}

  async invoke(request: JtpInvokeRequest, signal = new AbortController().signal): Promise<JtpResponse> {
    if (!request.id || !request.tool || !request.arguments || typeof request.arguments !== 'object') return { id: request.id ?? '', ok: false, error: { kind: 'protocol', code: 'INVALID_REQUEST', message: 'Invalid JTP request.', retryable: false } };
    if (this.completed.has(request.id)) return { id: request.id, ok: false, error: { kind: 'protocol', code: 'DUPLICATE_CALL', message: 'Call ID has already completed.', retryable: false } };
    const descriptor = this.registry.descriptor(request.tool);
    const provider = this.registry.provider(request.tool);
    if (!descriptor || !provider) return { id: request.id, ok: false, error: { kind: 'unavailable', code: 'UNKNOWN_TOOL', message: `Unknown tool: ${request.tool}`, retryable: false } };
    if (!this.registry.isEnabled(request.tool)) return { id: request.id, ok: false, error: { kind: 'unavailable', code: 'TOOL_DISABLED', message: `Tool is disabled: ${request.tool}`, retryable: false } };
    try {
      const response = await provider.invoke(request, { signal });
      this.completed.add(request.id);
      return response;
    } catch (error) {
      this.completed.add(request.id);
      return { id: request.id, ok: false, error: { kind: signal.aborted ? 'canceled' : 'execution', code: signal.aborted ? 'CANCELED' : 'PROVIDER_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false } };
    }
  }
}
