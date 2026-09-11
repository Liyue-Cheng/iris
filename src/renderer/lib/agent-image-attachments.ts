/**
 * @file src/renderer/lib/agent-image-attachments.ts
 * @purpose Turns files the user pasted, dropped or picked into Agent
 *   attachments the composer can show and the `send` call can carry.
 *
 * The renderer is deliberately not trusted about what an image *is*: main
 * sniffs the format and the pixel size from the bytes again on arrival. What
 * happens here is about ergonomics — rejecting the obvious non-image
 * immediately, and shrinking a large picture so one screenshot does not consume
 * a disproportionate part of the context window on every later request.
 */
import {
  AGENT_ATTACHMENT_MAX_COUNT,
  AGENT_ATTACHMENT_MAX_EDGE,
  AGENT_ATTACHMENT_MAX_TOTAL_BYTES,
  AGENT_IMAGE_MAX_BYTES,
} from '@shared/agent-protocol';
import { detectImageBytes, readImageSize } from '@shared/image-signature';
import type { IrisAgentAttachmentUpload, IrisAgentImageMimeType } from '@shared/types';

export interface PendingAgentImage {
  /** Stable key for React lists and removal. */
  id: string;
  name: string;
  mimeType: IrisAgentImageMimeType;
  /** Bytes that will actually be uploaded. */
  bytes: number;
  /** Encoded payload for the send call. */
  dataBase64: string;
  /** Object URL for the composer thumbnail; owned by the caller's lifetime. */
  previewUrl: string;
}

export type AgentImageRejection =
  | 'unsupported-type'
  | 'too-large'
  | 'too-many'
  | 'unreadable'
  | 'empty';

export class AgentImageError extends Error {
  constructor(
    public readonly reason: AgentImageRejection,
    message: string,
  ) {
    super(message);
    this.name = 'AgentImageError';
  }
}

const JPEG_QUALITY = 0.92;

/**
 * Reads one file into a pending attachment. Only a real raster image is
 * accepted: the format comes from the bytes, never from the file name, and SVG
 * is refused because its active content surface is much larger.
 */
export async function readAgentImageFile(file: File): Promise<PendingAgentImage> {
  const original = new Uint8Array(await file.arrayBuffer());
  const detected = detectImageBytes(original);
  if (!detected) {
    throw new AgentImageError(
      'unsupported-type',
      `${file.name || '该文件'} 不是受支持的图片格式（仅支持 PNG、JPEG、GIF、WebP、AVIF）。`,
    );
  }

  const originalSize = readImageSize(original, detected.mimeType);
  if (!originalSize) {
    throw new AgentImageError('unreadable', '无法读取图片尺寸，请换一张图片或先重新导出。');
  }
  const mustDownscale = Math.max(originalSize.width, originalSize.height) > AGENT_ATTACHMENT_MAX_EDGE;
  let prepared: { bytes: Uint8Array } | null;
  try {
    prepared = await downscaleIfNeeded(original, detected.mimeType);
  } catch {
    prepared = null;
  }
  if (mustDownscale && !prepared) {
    throw new AgentImageError(
      'unreadable',
      `图片长边超过 ${String(AGENT_ATTACHMENT_MAX_EDGE)}px，但缩放失败，请先手工缩小。`,
    );
  }
  const bytes = prepared?.bytes ?? original;
  if (bytes.byteLength > AGENT_IMAGE_MAX_BYTES) {
    throw new AgentImageError('too-large', '图片超过 5 MiB 上限，请先裁剪或压缩。');
  }
  if (bytes.byteLength === 0) {
    throw new AgentImageError('empty', '图片内容为空。');
  }

  // Shrinking can change the format (a huge PNG becomes a JPEG when it is
  // photographic), so the reported type is re-sniffed from the bytes we send.
  const finalFormat = detectImageBytes(bytes) ?? detected;
  const previewUrl = URL.createObjectURL(
    new Blob([toArrayBuffer(bytes)], { type: finalFormat.mimeType }),
  );
  return {
    id: crypto.randomUUID(),
    name: file.name || 'image',
    mimeType: finalFormat.mimeType,
    bytes: bytes.byteLength,
    dataBase64: encodeBase64(bytes),
    previewUrl,
  };
}

/** The send payload for a set of pending attachments. */
export function toAttachmentUploads(
  images: readonly PendingAgentImage[],
): IrisAgentAttachmentUpload[] {
  return images.map((image) => ({ name: image.name, dataBase64: image.dataBase64 }));
}

/** Enforces the per-request count before any file is read. */
export function assertAttachmentCapacity(current: number, incoming: number): void {
  if (current + incoming > AGENT_ATTACHMENT_MAX_COUNT) {
    throw new AgentImageError(
      'too-many',
      `一次最多只能附带 ${String(AGENT_ATTACHMENT_MAX_COUNT)} 张图片。`,
    );
  }
}

/** Enforces the decoded-byte ceiling for all images in one request. */
export function assertAttachmentTotalBytes(current: number, incoming: number): void {
  if (current + incoming > AGENT_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new AgentImageError('too-large', '附带图片的总大小超过 12 MiB 上限。');
  }
}

/** Files worth handing to `readAgentImageFile`; everything else is ignored. */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files];
  return files.filter((file) => file.type === '' || file.type.startsWith('image/'));
}

/**
 * Re-encodes an oversized image to fit the long-edge ceiling.
 *
 * The target format follows the source: a PNG stays PNG so screenshot text
 * keeps its edges, while everything else becomes JPEG because re-encoding a
 * photograph losslessly produces a file far larger than the original. The
 * original is kept whenever re-encoding does not actually help, so a small
 * image is never mangled for nothing.
 */
async function downscaleIfNeeded(
  bytes: Uint8Array,
  mimeType: IrisAgentImageMimeType,
): Promise<{ bytes: Uint8Array } | null> {
  const size = readImageSize(bytes, mimeType);
  if (!size) return null;
  const longest = Math.max(size.width, size.height);
  if (longest <= AGENT_ATTACHMENT_MAX_EDGE && bytes.byteLength <= AGENT_IMAGE_MAX_BYTES) return null;

  const scale = Math.min(1, AGENT_ATTACHMENT_MAX_EDGE / longest);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const bitmap = await createImageBitmap(new Blob([toArrayBuffer(bytes)], { type: mimeType }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const target: IrisAgentImageMimeType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await canvasToBlob(canvas, target);
    if (!blob) return null;
    const encoded = new Uint8Array(await blob.arrayBuffer());
    // Re-encoding a small file can easily make it bigger; only take it when it
    // is genuinely smaller than what we started with.
    return longest > AGENT_ATTACHMENT_MAX_EDGE || encoded.byteLength < bytes.byteLength
      ? { bytes: encoded }
      : null;
  } finally {
    bitmap.close();
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: IrisAgentImageMimeType,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, mimeType, mimeType === 'image/jpeg' ? JPEG_QUALITY : undefined);
  });
}

/** A `Uint8Array` view as a standalone `ArrayBuffer`, for Blob construction. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * base64 without Buffer, in chunks — `String.fromCharCode(...bytes)` on a
 * multi-megabyte array would blow the argument limit.
 */
function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
