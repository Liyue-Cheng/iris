import type { WindowContext } from './window-context';

/** A document reload retires its consumers, while the PTYs and mirrors survive. */
export function detachWindowRenderer(ctx: WindowContext): void {
  ctx.rendererEpoch += 1;
  ctx.outputAttachment = null;
  ctx.terminalSessionManager.detachAllOutputs();
  ctx.agentSessionManager.detachAllTerminalOutputs();
}

/**
 * did-navigate is a committed, cross-document main-frame navigation. A start
 * event can be followed by preventDefault, stop, or a download with no commit;
 * those attempts must leave the existing document and its consumers intact.
 * Commit fires before the new document's preload IPC is dispatched.
 */
export function wireRendererLifecycle(ctx: WindowContext): void {
  ctx.win.webContents.on('did-navigate', () => detachWindowRenderer(ctx));
}

/** Set before waiting for project-switch or backend cleanup promises. */
export function beginWindowShutdown(ctx: WindowContext): void {
  ctx.closing = true;
  detachWindowRenderer(ctx);
}
