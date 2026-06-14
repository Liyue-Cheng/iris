/**
 * One-shot migration: backfill the recommended agents (codex, gemini) into an
 * existing ~/.iris/settings.json so a user who already has a settings file
 * gets the expanded default launch set — the app's deep-merge replaces the
 * `agents` array wholesale, so new defaults never reach existing files on
 * their own (see .iris/issue/2026-06-14-终端的启动模板.md).
 *
 * Safe to re-run: agents already present by id are left untouched, along with
 * any user edits. Run with: node scripts/migrate-agents.mjs
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Recommended agents to ensure exist (matches DEFAULT_SETTINGS additions). */
const RECOMMENDED = [
  { id: 'codex', label: 'codex', command: 'codex', injection: 'hook', onExit: 'keep-shell' },
  { id: 'gemini', label: 'gemini', command: 'gemini', injection: 'hook', onExit: 'keep-shell' },
];

/** Both the packaged (~/.iris) and dev (~/.iris-dev) namespaces. */
const candidates = [
  join(homedir(), '.iris', 'settings.json'),
  join(homedir(), '.iris-dev', 'settings.json'),
];

function migrateFile(file) {
  if (!existsSync(file)) {
    console.log(`skip  ${file} (not found)`);
    return;
  }
  let settings;
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`error ${file}: invalid JSON — ${err.message}; left untouched`);
    return;
  }
  if (!Array.isArray(settings.agents)) {
    console.error(`error ${file}: no agents array; left untouched`);
    return;
  }

  const have = new Set(settings.agents.map((a) => a && a.id));
  const missing = RECOMMENDED.filter((r) => !have.has(r.id));
  if (missing.length === 0) {
    console.log(`ok    ${file} (already has codex/gemini)`);
    return;
  }

  // Insert before the first bare-shell ("终端") agent so the plain terminal
  // stays last; if there is none, append.
  const shellIdx = settings.agents.findIndex((a) => a && a.command === '');
  const at = shellIdx === -1 ? settings.agents.length : shellIdx;
  settings.agents.splice(at, 0, ...missing);

  const tmp = `${file}.migrate.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  console.log(`done  ${file}: added ${missing.map((m) => m.id).join(', ')}`);
}

for (const file of candidates) migrateFile(file);
