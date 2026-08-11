/**
 * @file src/preload/index.ts
 * @purpose Preload bridge: expose whitelisted IPC capabilities to the
 *   renderer as window.api. The thinnest possible bridge — no business
 *   logic, no direct ipcRenderer exposure.
 *
 * contextIsolation is on; sandbox is off (ESM preload, see main/index.ts).
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { platform, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  RemoteAppError,
  isIpcResult,
  type IpcRequest,
  type IpcRequestMeta,
} from '@shared/app-error';

/**
 * Windows build number (e.g. 22621), null elsewhere. @xterm/xterm 6.x's
 * windowsPty option needs it to pick the right ConPTY workaround branch
 * (>= 21376 modern reflow, else compat). Preload is the earliest sync spot
 * to read os — the Terminal constructor reads window.api.windowsBuild
 * without an IPC round trip (Marina's approach).
 */
const windowsBuild = ((): number | null => {
  if (platform() !== 'win32') return null;
  const parts = release().split('.');
  if (parts.length < 3) return null;
  const n = Number.parseInt(parts[2] ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

/** Invoke a main-process handler. Channel names from @shared/protocol. */
async function invoke<P, R>(
  channel: string,
  payload?: P,
  context?: { correlationId?: string },
): Promise<R> {
  const meta: IpcRequestMeta = { requestId: randomUUID() };
  if (context?.correlationId) meta.correlationId = context.correlationId;
  const request: IpcRequest<P | undefined> = { meta, payload };
  const result: unknown = await ipcRenderer.invoke(channel, request);
  if (!isIpcResult(result)) {
    throw new Error(`[preload] Invalid IPC result envelope for ${channel}`);
  }
  if (!result.ok) throw new RemoteAppError(result.error);
  return result.value as R;
}

/** Subscribe to a main → renderer event. Returns an unsubscribe fn. */
function on<P>(channel: string, handler: (payload: P) => void): () => void {
  const wrapped = (_event: unknown, payload: P): void => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.off(channel, wrapped);
  };
}

/** Resolve an OS-backed DOM File without exposing Node or Electron APIs. */
function getPathForFile(file: File): string {
  return webUtils.getPathForFile(file);
}

const api = {
  invoke,
  on,
  getPathForFile,
  windowsBuild,
} as const;

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
