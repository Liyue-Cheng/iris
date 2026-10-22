/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { detectImageBytes, imageExtensionFor, readImageSize } from './image-signature';

/** Minimal well-formed headers; the parsers only read the leading structure. */
const png = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
};

const gif = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'ascii');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
};

const jpeg = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0xffd8, 0);
  // APP0 with a two-byte length field, then SOF0 carrying the frame size.
  header.writeUInt16BE(0xffe0, 2);
  header.writeUInt16BE(4, 4);
  header.writeUInt16BE(0xffc0, 8);
  header.writeUInt16BE(11, 10);
  header[12] = 8;
  header.writeUInt16BE(height, 13);
  header.writeUInt16BE(width, 15);
  return header;
};

const webpLossy = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(30);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(22, 4);
  header.write('WEBP', 8, 'ascii');
  header.write('VP8 ', 12, 'ascii');
  header.writeUInt32LE(10, 16);
  header[20] = 0x00;
  header[23] = 0x9d;
  header[24] = 0x01;
  header[25] = 0x2a;
  header.writeUInt16LE(width, 26);
  header.writeUInt16LE(height, 28);
  return header;
};

const avif = (width: number, height: number): Buffer => {
  const box = (type: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, 'ascii');
    return Buffer.concat([header, payload]);
  };
  const ispe = box('ispe', (() => {
    const payload = Buffer.alloc(12);
    payload.writeUInt32BE(width, 4);
    payload.writeUInt32BE(height, 8);
    return payload;
  })());
  const ipco = box('ipco', ispe);
  const iprp = box('iprp', ipco);
  const meta = box('meta', Buffer.concat([Buffer.alloc(4), iprp]));
  const ftyp = box('ftyp', Buffer.from('avif', 'ascii'));
  return Buffer.concat([ftyp, meta]);
};

describe('image signature detection', () => {
  it('detects every supported raster format from its bytes alone', () => {
    expect(detectImageBytes(png(4, 4))).toEqual({ mimeType: 'image/png', extension: '.png' });
    expect(detectImageBytes(jpeg(4, 4))).toEqual({ mimeType: 'image/jpeg', extension: '.jpg' });
    expect(detectImageBytes(gif(4, 4))).toEqual({ mimeType: 'image/gif', extension: '.gif' });
    expect(detectImageBytes(webpLossy(4, 4))).toEqual({ mimeType: 'image/webp', extension: '.webp' });
    expect(detectImageBytes(avif(4, 4))).toEqual({ mimeType: 'image/avif', extension: '.avif' });
  });

  it('refuses SVG and anything that is not a known raster signature', () => {
    expect(detectImageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImageBytes(Buffer.from('plain text that claims nothing'))).toBeNull();
    expect(detectImageBytes(Buffer.alloc(0))).toBeNull();
  });

  it('maps MIME types back to their canonical extension', () => {
    expect(imageExtensionFor('image/png')).toBe('.png');
    expect(imageExtensionFor('image/jpeg')).toBe('.jpg');
    expect(imageExtensionFor('image/webp')).toBe('.webp');
  });
});

describe('image intrinsic size', () => {
  it('reads the size of every supported format', () => {
    expect(readImageSize(png(1280, 720), 'image/png')).toEqual({ width: 1280, height: 720 });
    expect(readImageSize(jpeg(800, 600), 'image/jpeg')).toEqual({ width: 800, height: 600 });
    expect(readImageSize(gif(320, 240), 'image/gif')).toEqual({ width: 320, height: 240 });
    expect(readImageSize(webpLossy(1024, 768), 'image/webp')).toEqual({ width: 1024, height: 768 });
    expect(readImageSize(avif(640, 480), 'image/avif')).toEqual({ width: 640, height: 480 });
  });

  it('reports no size instead of guessing when the header cannot be read', () => {
    expect(readImageSize(Buffer.alloc(4), 'image/png')).toBeNull();
    // A truncated JPEG stops before its frame header.
    expect(readImageSize(jpeg(800, 600).subarray(0, 10), 'image/jpeg')).toBeNull();
    expect(readImageSize(Buffer.from('not an image at all'), 'image/webp')).toBeNull();
  });

  it('rejects an absurd or zero dimension rather than feeding a bogus denominator', () => {
    expect(readImageSize(png(0, 720), 'image/png')).toBeNull();
    expect(readImageSize(png(70_000, 10), 'image/png')).toBeNull();
  });
});
