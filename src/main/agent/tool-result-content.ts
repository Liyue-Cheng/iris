/**
 * @file src/main/agent/tool-result-content.ts
 * @purpose The single place that turns a settled tool result into the content
 *   blocks a provider receives.
 *
 * The Worker owns this translation on the real execution path, and the Pi tool
 * definitions own it when a tool is invoked directly. Keeping it in one pure
 * function means a live turn and a replayed history can never describe the same
 * result differently, and it makes the production path testable without a
 * worker thread.
 */
import type { JtpBuiltinResult } from '@shared/agent-protocol';

export type AgentToolResultContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Builds the provider-facing content for one tool result. An image keeps its
 * caption next to the pixels instead of replacing it: the model needs a
 * citable name for what it just looked at, and a bare image block gives it
 * nothing to refer back to.
 */
export function renderToolResultContent(
  toolName: string,
  toolArguments: Record<string, unknown> | undefined,
  result: JtpBuiltinResult,
): AgentToolResultContentPart[] {
  if (result.kind === 'image') {
    return [
      { type: 'text', text: renderReadImageSummary(readPath(toolArguments), result) },
      { type: 'image', data: result.contentBase64, mimeType: result.mimeType },
    ];
  }
  return [{ type: 'text', text: renderToolResultText(toolName, result) }];
}

/** The readable half of a result, for results that carry no pixels. */
export function renderToolResultText(toolName: string, result: JtpBuiltinResult): string {
  switch (result.kind) {
    case 'file':
      return Buffer.from(result.contentBase64, 'base64').toString('utf8');
    case 'terminal':
    case 'task':
      return result.outputText;
    case 'image':
      // Unreachable through `renderToolResultContent`, but a caller that asks
      // only for text still gets an honest description of what came back.
      return renderReadImageSummary('image', result);
    case 'void':
      return result.message ?? '';
    default:
      return unhandledResult(toolName, result);
  }
}

/**
 * The text half of an image read. The model needs to know what it received, so
 * the caption names the file, its type, its pixel size and its weight.
 */
export function renderReadImageSummary(
  path: string,
  image: { mimeType: string; bytes: number; width?: number; height?: number },
): string {
  const dimensions = image.width && image.height
    ? ` ${String(image.width)}x${String(image.height)}`
    : '';
  return `${path}: image ${image.mimeType}${dimensions} (${formatImageBytes(image.bytes)}).`;
}

function readPath(toolArguments: Record<string, unknown> | undefined): string {
  const candidate = toolArguments?.path;
  return typeof candidate === 'string' && candidate ? candidate : 'image';
}

function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function unhandledResult(toolName: string, result: never): never {
  throw new Error(
    `Iris Agent tool ${toolName} returned an unsupported result: ${JSON.stringify(result)}`,
  );
}

