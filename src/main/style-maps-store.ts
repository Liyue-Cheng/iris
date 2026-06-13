/**
 * @file src/main/style-maps-store.ts
 * @purpose IO side of the style tables: read the effective maps for the
 *   open project (project file → machine file → builtin), write the
 *   project file, and seed it at project init from the machine defaults.
 *
 * Both files are plain JSON (`styles.json`). Reads are tolerant: a missing
 * or corrupt file silently falls through to the next layer — style config
 * must never break the app (it only affects badge colors).
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_STYLE_MAPS,
  sanitizeStyleMaps,
  type StyleMaps,
  type StyleMapsState,
} from '@shared/style-maps';
import { appDataDir } from './settings-manager';
import { logger } from './logger';

export function machineStylesPath(): string {
  return join(appDataDir(), 'styles.json');
}

/** appDataDir needs the electron `app` object; unit tests (and any other
 *  non-electron context) get null and fall through to the builtins. */
function safeMachineStylesPath(): string | null {
  try {
    return machineStylesPath();
  } catch {
    return null;
  }
}

export function projectStylesPath(projectRoot: string): string {
  return join(projectRoot, '.iris', 'styles.json');
}

async function readMapsFile(path: string): Promise<StyleMaps | null> {
  try {
    const text = await fs.readFile(path, 'utf8');
    return sanitizeStyleMaps(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Machine defaults: ~/.iris/styles.json, falling back to the builtins. */
export async function machineStyleMaps(): Promise<StyleMaps> {
  const path = safeMachineStylesPath();
  return (path ? await readMapsFile(path) : null) ?? DEFAULT_STYLE_MAPS;
}

/** Effective maps for a project (null root = no project open). */
export async function effectiveStyleMaps(projectRoot: string | null): Promise<StyleMapsState> {
  if (projectRoot) {
    const project = await readMapsFile(projectStylesPath(projectRoot));
    if (project) return { maps: project, source: 'project' };
  }
  const machinePath = safeMachineStylesPath();
  const machine = machinePath ? await readMapsFile(machinePath) : null;
  if (machine) return { maps: machine, source: 'machine' };
  return { maps: DEFAULT_STYLE_MAPS, source: 'builtin' };
}

/** Write the project-level table (styles.update instruction body). */
export async function writeProjectStyleMaps(
  projectRoot: string,
  maps: StyleMaps,
): Promise<StyleMapsState> {
  const sane = sanitizeStyleMaps(maps) ?? DEFAULT_STYLE_MAPS;
  const path = projectStylesPath(projectRoot);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(sane, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, path);
  return { maps: sane, source: 'project' };
}

/**
 * Seed `.iris/styles.json` from the machine defaults — project init only,
 * never overwrites (the project file is project-owned once it exists).
 */
export async function seedProjectStyleMaps(projectRoot: string): Promise<'created' | 'already-exists'> {
  const path = projectStylesPath(projectRoot);
  try {
    await fs.access(path);
    return 'already-exists';
  } catch {
    /* absent — seed below */
  }
  const seed = await machineStyleMaps();
  try {
    await fs.writeFile(path, `${JSON.stringify(seed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return 'created';
  } catch (err) {
    logger.warn('styles', `seed failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'already-exists';
  }
}
