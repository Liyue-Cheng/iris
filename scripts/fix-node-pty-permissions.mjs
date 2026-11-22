#!/usr/bin/env node
import { chmod, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helpers = [
  resolve(root, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'),
  resolve(root, 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'),
  resolve(root, 'node_modules/node-pty/build/Release/spawn-helper'),
];

let fixed = 0;
for (const helper of helpers) {
  try {
    if (!(await stat(helper)).isFile()) continue;
    await chmod(helper, 0o755);
    fixed += 1;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

if (fixed === 0) {
  throw new Error('node-pty spawn-helper was not found after installation');
}
console.log(`[postinstall] ensured executable node-pty spawn-helper (${fixed})`);
