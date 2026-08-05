import type { DocImageResult } from '@shared/types';
import { CHANNELS } from '@shared/protocol';

const DIRECT_IMAGE_PROTOCOL = /^(?:data:image\/(?:png|jpeg|gif|webp|avif);|blob:|https:)/i;
const BLOCKED_PROTOCOL = /^(?:[a-z][a-z\d+.-]*:|[/\\])/i;

export async function resolveMarkdownImage(docPath: string, source: string): Promise<string> {
  const value = source.trim();
  if (DIRECT_IMAGE_PROTOCOL.test(value)) return value;
  if (!value || BLOCKED_PROTOCOL.test(value)) return failedImageUrl();

  try {
    const result = await window.api.invoke<
      { docPath: string; source: string },
      DocImageResult
    >(CHANNELS.DOC_IMAGE_READ, { docPath, source: value });
    return result.dataUrl ?? failedImageUrl();
  } catch {
    return failedImageUrl();
  }
}

export function markImageLoadFailure(event: Event): void {
  const image = event.currentTarget instanceof HTMLImageElement ? event.currentTarget : null;
  if (!image) return;
  image.dataset.loadFailed = 'true';
  image.alt = image.alt ? `图片加载失败：${image.alt}` : '图片加载失败';
}

function failedImageUrl(): string {
  return 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
}
