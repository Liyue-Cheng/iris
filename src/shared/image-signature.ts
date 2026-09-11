/**
 * @file src/shared/image-signature.ts
 * @purpose Image format detection and intrinsic size parsing, shared by the
 *   document asset manager, the Agent read path and the renderer composer.
 *
 * Detection is by magic bytes, never by file name or an extension: a renamed
 * `.png` is still detected as whatever its bytes actually are, and SVG stays
 * unsupported on purpose because its active content surface is much larger.
 *
 * Deliberately free of Node and Electron dependencies — it takes a plain
 * `Uint8Array` and reads it with `DataView` — so the main process and the
 * sandboxed renderer can share one table instead of keeping divergent copies
 * of "what counts as an image".
 */
import type { IrisAgentImageMimeType } from './types';

export interface DetectedImage {
  mimeType: IrisAgentImageMimeType;
  extension: string;
}

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Detect a supported raster image from its leading bytes. */
export function detectImageBytes(bytes: Uint8Array): DetectedImage | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  const magic = asciiAt(bytes, 0, 16);
  if (magic.startsWith('GIF87a') || magic.startsWith('GIF89a')) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (magic.startsWith('RIFF') && asciiAt(bytes, 8, 4) === 'WEBP') {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  if (bytes.length >= 12 && asciiAt(bytes, 4, 4) === 'ftyp') {
    const brand = asciiAt(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') {
      return { mimeType: 'image/avif', extension: '.avif' };
    }
  }
  return null;
}

/** The canonical extension for a supported image MIME type, without sniffing. */
export function imageExtensionFor(mimeType: IrisAgentImageMimeType): string {
  return mimeType === 'image/jpeg' ? '.jpg' : `.${mimeType.slice('image/'.length)}`;
}

/**
 * Intrinsic pixel size, used for the model's token estimate and for card
 * thumbnails. Every parser is best-effort: an image whose header cannot be read
 * still renders, it just reports no size instead of a guessed one.
 */
export function readImageSize(bytes: Uint8Array, mimeType: IrisAgentImageMimeType): ImageSize | null {
  try {
    switch (mimeType) {
      case 'image/png': return readPngSize(bytes);
      case 'image/jpeg': return readJpegSize(bytes);
      case 'image/gif': return readGifSize(bytes);
      case 'image/webp': return readWebpSize(bytes);
      case 'image/avif': return readAvifSize(bytes);
      default: return null;
    }
  } catch {
    // A truncated file makes DataView throw; that is a "no size", not a failure.
    return null;
  }
}

function readPngSize(bytes: Uint8Array): ImageSize | null {
  // 8-byte signature, then the IHDR chunk: length(4) type(4) width(4) height(4).
  if (bytes.length < 24 || asciiAt(bytes, 12, 4) !== 'IHDR') return null;
  const view = viewOf(bytes);
  return sizeOrNull(view.getUint32(16, false), view.getUint32(20, false));
}

function readGifSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null;
  const view = viewOf(bytes);
  return sizeOrNull(view.getUint16(6, true), view.getUint16(8, true));
}

function readWebpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  const chunk = asciiAt(bytes, 12, 4);
  const view = viewOf(bytes);
  if (chunk === 'VP8X') {
    return sizeOrNull(readUInt24LE(bytes, 24) + 1, readUInt24LE(bytes, 27) + 1);
  }
  if (chunk === 'VP8 ') {
    // Lossy: a 3-byte frame tag, the 9d 01 2a start code, then 14-bit sizes.
    const start = 20;
    if (bytes.length < start + 10) return null;
    if (bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) return null;
    return sizeOrNull(
      view.getUint16(start + 6, true) & 0x3fff,
      view.getUint16(start + 8, true) & 0x3fff,
    );
  }
  if (chunk === 'VP8L') {
    const start = 20;
    if (bytes.length < start + 5 || bytes[start] !== 0x2f) return null;
    const bits = view.getUint32(start + 1, true);
    return sizeOrNull((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

/**
 * AVIF carries its coded size in an `ispe` box nested inside
 * `meta` -> `iprp` -> `ipco`, so the walk descends only those containers and
 * stops at the first `ispe` rather than searching the whole file.
 */
function readAvifSize(bytes: Uint8Array): ImageSize | null {
  const meta = findBox(bytes, 0, bytes.length, 'meta');
  if (!meta) return null;
  const iprp = findBox(bytes, meta.start + 4, meta.end, 'iprp');
  if (!iprp) return null;
  const ipco = findBox(bytes, iprp.start, iprp.end, 'ipco');
  if (!ipco) return null;
  const ispe = findBox(bytes, ipco.start, ipco.end, 'ispe');
  if (!ispe) return null;
  const payload = ispe.start + 4;
  if (payload + 8 > ispe.end) return null;
  const view = viewOf(bytes);
  return sizeOrNull(view.getUint32(payload, false), view.getUint32(payload + 4, false));
}

/** Iterate sibling boxes and return the payload of the first matching type. */
function findBox(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: string,
): { start: number; end: number } | null {
  const view = viewOf(bytes);
  let cursor = start;
  while (cursor + 8 <= end) {
    const size = view.getUint32(cursor, false);
    if (size < 8 || cursor + size > end) return null;
    if (asciiAt(bytes, cursor + 4, 4) === type) {
      return { start: cursor + 8, end: cursor + size };
    }
    cursor += size;
  }
  return null;
}

function readJpegSize(bytes: Uint8Array): ImageSize | null {
  const view = viewOf(bytes);
  let cursor = 2;
  while (cursor + 4 <= bytes.length) {
    if (bytes[cursor] !== 0xff) {
      cursor += 1;
      continue;
    }
    const marker = bytes[cursor + 1]!;
    // Padding and standalone markers carry no length field.
    if (marker === 0xff) {
      cursor += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      cursor += 2;
      continue;
    }
    const length = view.getUint16(cursor + 2, false);
    if (length < 2) return null;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (cursor + 9 > bytes.length) return null;
      return sizeOrNull(view.getUint16(cursor + 7, false), view.getUint16(cursor + 5, false));
    }
    cursor += 2 + length;
  }
  return null;
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function sizeOrNull(width: number, height: number): ImageSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  // A corrupt or hostile header must not produce an absurd denominator.
  if (width > 65_535 || height > 65_535) return null;
  return { width: Math.floor(width), height: Math.floor(height) };
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Latin-1 read of a short header field; never used on the whole buffer.
 * Clamped like `subarray`, so a truncated header yields a short string instead
 * of nothing at all.
 */
function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset >= bytes.length) return '';
  const end = Math.min(bytes.length, offset + length);
  let text = '';
  for (let index = offset; index < end; index += 1) {
    text += String.fromCharCode(bytes[index]!);
  }
  return text;
}
