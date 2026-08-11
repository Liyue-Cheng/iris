import { randomUUID } from 'node:crypto';
import { promises as fs, renameSync, rmSync } from 'node:fs';
import { dirname, extname } from 'node:path';

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  beforeReplace?: () => Promise<void>;
}

/** Build a unique same-directory path whose final extension identifies it as temporary. */
export function siblingTempPath(target: string): string {
  return `${target}.${process.pid}.${randomUUID()}.tmp`;
}

/** Keep a file's semantic extension last when adding a numbered rotation suffix. */
export function rotatedFilePath(target: string, generation = 1): string {
  const extension = extname(target);
  if (!extension) return `${target}.${generation}`;
  return `${target.slice(0, -extension.length)}.${generation}${extension}`;
}

/** Rotate one generation while keeping the semantic extension stable. */
export function rotateFileOnce(target: string): string {
  const rotated = rotatedFilePath(target);
  rmSync(rotated, { force: true });
  renameSync(target, rotated);
  return rotated;
}

/** Write, fsync, and replace through a uniquely owned sibling temp file. */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true });
  const temp = siblingTempPath(target);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let ownsTemp = false;

  try {
    handle = await fs.open(temp, 'wx');
    ownsTemp = true;
    if (typeof data === 'string') await handle.writeFile(data, options.encoding ?? 'utf8');
    else await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;

    await options.beforeReplace?.();
    await fs.rename(temp, target);
    ownsTemp = false;
  } catch (err) {
    await handle?.close().catch(() => {});
    if (ownsTemp) await fs.unlink(temp).catch(() => {});
    throw err;
  }
}
