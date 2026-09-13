import type { JtpEffect } from './protocol';

export interface JtpToolDescriptor {
  id: string;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  errors?: Array<{ code: string; description: string }>;
  effects: JtpEffect;
  provider: string;
  enabledByDefault: boolean;
}

export function validateDescriptor(descriptor: JtpToolDescriptor): void {
  if (!descriptor.id || !/^[a-z][a-z0-9._-]*$/u.test(descriptor.id)) throw new Error(`Invalid JTP tool id: ${descriptor.id}`);
  if (!descriptor.title || !descriptor.description) throw new Error(`JTP tool ${descriptor.id} needs title and description`);
  if (!descriptor.inputSchema || typeof descriptor.inputSchema !== 'object') throw new Error(`JTP tool ${descriptor.id} has no input schema`);
}
