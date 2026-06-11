/**
 * @file src/main/machine-layer.ts
 * @purpose The machine-level constitution (~/.iris/CONVENTIONS.md, 附录 C):
 *   install-template gesture + state query. App-side involvement ends at
 *   writing the template — the file is human-owned from byte one (wx flag,
 *   never overwrite), and the App never parses it (CONVENTIONS.md 给 agent
 *   读；settings 给 App 读 — 各读各的).
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { irisHomeDir } from './settings-manager';
import { MACHINE_CONVENTIONS_TEMPLATE } from './iris-templates';

export function machineConventionsPath(): string {
  return join(irisHomeDir(), 'CONVENTIONS.md');
}

export async function machineConventionsState(): Promise<{ exists: boolean; path: string }> {
  const path = machineConventionsPath();
  try {
    await fs.access(path);
    return { exists: true, path };
  } catch {
    return { exists: false, path };
  }
}

/** Install the template. Throws if the file already exists (never clobber). */
export async function installMachineConventions(): Promise<{ path: string }> {
  const path = machineConventionsPath();
  await fs.mkdir(irisHomeDir(), { recursive: true });
  await fs.writeFile(path, MACHINE_CONVENTIONS_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
  return { path };
}
