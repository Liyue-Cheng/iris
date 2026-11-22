// Verify Chromium's real navigation/preload ordering with production lifecycle
// code. No app build, development server, visible window, or user profile.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'iris-renderer-lifecycle-'));
const entry = join(temporary, 'probe.cjs');
await build({
  entryPoints: [join(root, 'scripts/fixtures/renderer-lifecycle-probe.ts')],
  outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  tsconfig: join(root, 'tsconfig.node.json'),
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [entry], { env, windowsHide: true, stdio: 'inherit' });
const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 35_000);
child.on('error', error => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(deadline);
  console.log(`Renderer lifecycle diagnostic: ${temporary}`);
  process.exitCode = code ?? 1;
});
