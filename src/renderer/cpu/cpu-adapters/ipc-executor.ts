/**
 * The `ipc` executor — Iris's counterpart of cutie's HTTP adapter
 * (technical-design.md 复用 front-cpu / Iris 侧的用法差异).
 *
 * Instructions stay declarative: they declare `executor: 'ipc'` and
 * `config: { channel }`; the payload is forwarded to the main process over
 * the preload bridge. No HTTP client is configured at all — Iris has no
 * backend.
 */
import type { ExecutorFn } from 'front-cpu';

export interface IpcExecutorConfig {
  channel: string;
}

export const ipcExecutor: ExecutorFn = (config, payload) => {
  const { channel } = config as IpcExecutorConfig;
  if (typeof channel !== 'string' || !channel) {
    return Promise.reject(
      new Error(`[ipcExecutor] instruction config must declare a non-empty channel`),
    );
  }
  return window.api.invoke(channel, payload);
};
