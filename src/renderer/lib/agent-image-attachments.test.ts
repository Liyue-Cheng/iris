import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentImageError,
  assertAttachmentCapacity,
  assertAttachmentTotalBytes,
  imageFilesFrom,
  readAgentImageFile,
  toAttachmentUploads,
  type PendingAgentImage,
} from './agent-image-attachments';

/** Minimal well-formed headers; the sniffer only reads the leading structure. */
function png(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(24 + padding);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  for (const [index, character] of [...'IHDR'].entries()) bytes[12 + index] = character.charCodeAt(0);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  for (const [index, character] of [...'GIF89a'].entries()) bytes[index] = character.charCodeAt(0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function fileOf(bytes: Uint8Array, name: string, type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.unstubAllGlobals();
});

/** jsdom has no object-URL support and no canvas decoding. */
function stubObjectUrls(): void {
  URL.createObjectURL = () => 'blob:preview';
  URL.revokeObjectURL = () => undefined;
}

describe('agent image attachments', () => {
  it('accepts a supported image and reports the sniffed format, not the file type', async () => {
    stubObjectUrls();
    // The declared MIME type is deliberately wrong; the bytes decide.
    const attachment = await readAgentImageFile(fileOf(png(4, 4), 'shot.png', 'application/pdf'));
    expect(attachment).toMatchObject({
      name: 'shot.png',
      mimeType: 'image/png',
      bytes: 24,
      previewUrl: 'blob:preview',
    });
    expect(attachment.dataBase64).toBe(btoa(String.fromCharCode(...png(4, 4))));
  });

  it('refuses SVG and anything that is not a raster image signature', async () => {
    stubObjectUrls();
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'vector.svg', {
      type: 'image/svg+xml',
    });
    await expect(readAgentImageFile(svg)).rejects.toBeInstanceOf(AgentImageError);
    await expect(readAgentImageFile(svg)).rejects.toThrow(/不是受支持的图片格式/);
    await expect(readAgentImageFile(new File(['plain text'], 'notes.txt')))
      .rejects.toThrow(/不是受支持的图片格式/);
  });

  it('keeps the original bytes when no downscale is possible or needed', async () => {
    stubObjectUrls();
    // jsdom cannot decode images, so the downscale path yields nothing and the
    // original is used — which is also what happens for an already-small file.
    const bytes = gif(320, 240);
    const attachment = await readAgentImageFile(fileOf(bytes, 'anim.gif', 'image/gif'));
    expect(attachment.mimeType).toBe('image/gif');
    expect(attachment.bytes).toBe(bytes.byteLength);
  });

  it('refuses an image over the per-file ceiling', async () => {
    stubObjectUrls();
    const oversized = fileOf(png(4, 4, 6 * 1024 * 1024), 'huge.png', 'image/png');
    await expect(readAgentImageFile(oversized)).rejects.toThrow(/5 MiB/);
  });

  it('refuses an oversized long edge when the renderer cannot downscale it', async () => {
    stubObjectUrls();
    await expect(readAgentImageFile(fileOf(png(3840, 2160), '4k.png', 'image/png')))
      .rejects.toThrow(/缩放失败/);
  });

  it('enforces the per-request count before any file is read', () => {
    expect(() => assertAttachmentCapacity(0, 5)).not.toThrow();
    expect(() => assertAttachmentCapacity(1, 5)).toThrow(/最多只能附带 5 张图片/);
    expect(() => assertAttachmentCapacity(4, 2)).toThrow(AgentImageError);
  });

  it('enforces the per-request decoded byte ceiling', () => {
    expect(() => assertAttachmentTotalBytes(8 * 1024 * 1024, 4 * 1024 * 1024)).not.toThrow();
    expect(() => assertAttachmentTotalBytes(8 * 1024 * 1024, 4 * 1024 * 1024 + 1))
      .toThrow(/12 MiB/);
  });

  it('maps pending attachments to the wire payload without extra fields', () => {
    const pending: PendingAgentImage[] = [{
      id: 'a', name: 'shot.png', mimeType: 'image/png', bytes: 3,
      dataBase64: 'AAAA', previewUrl: 'blob:preview',
    }];
    expect(toAttachmentUploads(pending)).toEqual([{ name: 'shot.png', dataBase64: 'AAAA' }]);
  });

  it('takes only image files out of a drop or paste payload', () => {
    expect(imageFilesFrom(null)).toEqual([]);
    const image = fileOf(png(4, 4), 'shot.png', 'image/png');
    const text = fileOf(new Uint8Array([1, 2, 3]), 'notes.txt', 'text/plain');
    // A clipboard image often arrives with no declared type at all, so an empty
    // type is kept and let the byte sniffing decide.
    const untyped = new File([new Uint8Array(png(4, 4))], 'clipboard', { type: '' });
    const data = { files: [image, text, untyped] } as unknown as DataTransfer;
    expect(imageFilesFrom(data)).toEqual([image, untyped]);
  });
});
