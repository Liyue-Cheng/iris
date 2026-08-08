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
import { projectScopeState } from '@renderer/stores/project-scope-state';

export interface IpcExecutorConfig {
  channel: string;
  /** Attach the committed window project identity for main-side validation. */
  projectScoped?: boolean;
}

export const ipcExecutor: ExecutorFn = (config, payload) => {
  const { channel, projectScoped } = config as IpcExecutorConfig;
  if (typeof channel !== 'string' || !channel) {
    return Promise.reject(
      new Error(`[ipcExecutor] instruction config must declare a non-empty channel`),
    );
  }
  if (!projectScoped) return window.api.invoke(channel, payload);
  const body = payload && typeof payload === 'object' ? payload : {};
  return window.api.invoke(channel, {
    ...body,
    expectedScope: projectScopeState.get(),
  });
};
