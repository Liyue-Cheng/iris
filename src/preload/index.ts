/**
 * @file src/preload/index.ts
 * @purpose Preload bridge: expose whitelisted IPC capabilities to the
 *   renderer as window.api. The thinnest possible bridge — no business
 *   logic, no direct ipcRenderer exposure.
 *
 * contextIsolation is on; sandbox is off (ESM preload, see main/index.ts).
 */
import { contextBridge, ipcRenderer } from 'electron';

/** Invoke a main-process handler. Channel names from @shared/protocol. */
async function invoke<P, R>(channel: string, payload?: P): Promise<R> {
  return ipcRenderer.invoke(channel, payload) as Promise<R>;
}

/** Subscribe to a main → renderer event. Returns an unsubscribe fn. */
function on<P>(channel: string, handler: (payload: P) => void): () => void {
  const wrapped = (_event: unknown, payload: P): void => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.off(channel, wrapped);
  };
}

const api = {
  invoke,
  on,
} as const;

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
