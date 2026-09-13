import { useSyncExternalStore } from 'react';
import { CHANNELS, EVENTS } from '@shared/protocol';
type JtpEvent = { type: 'started' | 'completed' | 'failed'; id: string; tool: string; at: number };
export interface JtpToolView { id: string; title: string; description: string; provider: string; enabled: boolean; }
export interface JtpCallView { id: string; tool: string; state: 'started' | 'completed' | 'failed'; at: number; }
let tools: readonly JtpToolView[] = [];
let calls: readonly JtpCallView[] = [];
const subscribers = new Set<() => void>();
const emit = (): void => subscribers.forEach((subscriber) => subscriber());
export async function hydrateJtpTools(): Promise<void> { tools = await window.api.invoke<undefined, JtpToolView[]>(CHANNELS.IRIS_AGENT_TOOLS); emit(); }
let wired = false;
export function wireJtpTools(): void { if (wired) return; wired = true; window.api.on(EVENTS.IRIS_AGENT_TOOLS_CHANGED, () => { void hydrateJtpTools().catch(() => undefined); }); }
export function wireJtpEvents(): void { window.api.on<JtpEvent>(EVENTS.IRIS_AGENT_JTP_EVENT, (event) => { calls = [{ id: event.id, tool: event.tool, state: event.type, at: event.at }, ...calls].slice(0, 100); emit(); }); }
export function getJtpTools(): readonly JtpToolView[] { return tools; }
export function getJtpCalls(): readonly JtpCallView[] { return calls; }
export function subscribeJtpTools(listener: () => void): () => void { subscribers.add(listener); return () => subscribers.delete(listener); }
export function useJtpTools(): readonly JtpToolView[] { return useSyncExternalStore(subscribeJtpTools, getJtpTools, getJtpTools); }
