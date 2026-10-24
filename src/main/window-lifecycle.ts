import type { WindowContext } from './window-context';

/** A document reload retires its consumers, while the PTYs and mirrors survive. */
export function detachWindowRenderer(ctx: WindowContext): void {
  ctx.rendererEpoch += 1;
  ctx.outputAttachment = null;
  ctx.terminalSessionManager.detachAllOutputs();
  ctx.agentSessionManager.detachAllTerminalOutputs();
}

export function beginRendererNavigation(ctx: WindowContext): void {
  ctx.rendererNavigating = true;
  detachWindowRenderer(ctx);
}

/** Set before waiting for project-switch or backend cleanup promises. */
export function beginWindowShutdown(ctx: WindowContext): void {
  ctx.closing = true;
  detachWindowRenderer(ctx);
}
