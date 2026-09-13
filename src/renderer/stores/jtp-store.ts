import { useSyncExternalStore } from 'react';
import { CHANNELS, EVENTS } from '@shared/protocol';
export interface JtpToolView { id: string; title: string; description: string; provider: string; enabled: boolean; }
let tools: readonly JtpToolView[] = [];
const subscribers = new Set<() => void>();
const emit = (): void => subscribers.forEach((subscriber) => subscriber());
export async function hydrateJtpTools(): Promise<void> { tools = await window.api.invoke<undefined, JtpToolView[]>(CHANNELS.IRIS_AGENT_TOOLS); emit(); }
let wired = false;
export function wireJtpTools(): void { if (wired) return; wired = true; window.api.on(EVENTS.IRIS_AGENT_TOOLS_CHANGED, () => void hydrateJtpTools()); }
export function getJtpTools(): readonly JtpToolView[] { return tools; }
export function subscribeJtpTools(listener: () => void): () => void { subscribers.add(listener); return () => subscribers.delete(listener); }
export function useJtpTools(): readonly JtpToolView[] { return useSyncExternalStore(subscribeJtpTools, getJtpTools, getJtpTools); }
