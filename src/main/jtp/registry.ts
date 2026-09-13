import type { Tool } from '@earendil-works/pi-ai/compat';
import type { JtpToolDescriptor } from './descriptor';
import { validateDescriptor } from './descriptor';
import type { JtpProvider } from './provider';

export class JtpRegistry {
  private readonly descriptors = new Map<string, JtpToolDescriptor>();
  private readonly providers = new Map<string, JtpProvider>();
  private enabled = new Set<string>();

  register(descriptor: JtpToolDescriptor, provider: JtpProvider): void {
    validateDescriptor(descriptor);
    if (this.descriptors.has(descriptor.id)) throw new Error(`Duplicate JTP tool: ${descriptor.id}`);
    this.descriptors.set(descriptor.id, descriptor);
    this.providers.set(descriptor.id, provider);
    if (descriptor.enabledByDefault) this.enabled.add(descriptor.id);
  }

  registerMany(entries: ReadonlyArray<{ descriptor: JtpToolDescriptor; provider: JtpProvider }>): void {
    for (const entry of entries) this.register(entry.descriptor, entry.provider);
  }

  setEnabled(ids: Iterable<string>): void { this.enabled = new Set(ids); }
  isEnabled(id: string): boolean { return this.enabled.has(id); }
  descriptor(id: string): JtpToolDescriptor | undefined { return this.descriptors.get(id); }
  provider(id: string): JtpProvider | undefined { return this.providers.get(id); }
  descriptorsList(): JtpToolDescriptor[] { return [...this.descriptors.values()]; }
  snapshot(): Array<JtpToolDescriptor & { enabled: boolean }> {
    return this.descriptorsList().map((descriptor) => ({ ...descriptor, enabled: this.enabled.has(descriptor.id) }));
  }
  modelTools(): Tool[] {
    return this.descriptorsList().filter((d) => this.enabled.has(d.id)).map((d) => ({ name: d.id, description: d.description, parameters: d.inputSchema })) as Tool[];
  }
}
