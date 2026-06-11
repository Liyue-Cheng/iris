#!/usr/bin/env node
/**
 * @file scripts/smoke-launch.mjs
 * @purpose Launch smoke test, ported from Marina. Verifies that the built
 *   app's main process + a BrowserWindow survive 5s without preload-error /
 *   render-process-gone. Catches "the program doesn't even start" failures
 *   that unit tests with mocks never see.
 *
 * Usage:
 *   npm run build
 *   npm run smoke
 *
 * Exit codes: 0 = pass, 1 = fail.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const mainEntry = resolve(projectRoot, 'out/main/index.js');

if (!existsSync(mainEntry)) {
  console.error('[smoke] out/main/index.js missing — run `npm run build` first');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const electronPath = require('electron');
if (typeof electronPath !== 'string') {
  console.error('[smoke] electron module did not return an executable path');
  process.exit(1);
}

const TIMEOUT_MS = 5000;
const FATAL_PATTERNS = [
  /preload-error/i,
  /render-process-gone/i,
  /UnhandledPromiseRejection/i,
  /FATAL ERROR/,
  /Check failed:/,
];
const MILESTONE_PATTERN = /bootstrap starting/i;

let milestoneSeen = false;
let fatalMessage = null;
let timeoutHandle = null;
let resolved = false;

function finish(passed, reason) {
  if (resolved) return;
  resolved = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  try {
    if (!child.killed) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    }
  } catch {
    /* ignore */
  }
  if (passed) {
    console.log(`[smoke] PASS — ${reason}`);
    process.exit(0);
  } else {
    console.error(`[smoke] FAIL — ${reason}`);
    process.exit(1);
  }
}

function inspectChunk(chunk, streamName) {
  const text = chunk.toString('utf8');
  process.stdout.write(`[${streamName}] ${text}`);
  for (const pat of FATAL_PATTERNS) {
    if (pat.test(text)) {
      fatalMessage = `fatal pattern ${pat} on ${streamName}`;
      finish(false, fatalMessage);
      return;
    }
  }
  if (!milestoneSeen && MILESTONE_PATTERN.test(text)) {
    milestoneSeen = true;
  }
}

console.log(`[smoke] spawning electron — entry=${pathToFileURL(mainEntry).href}`);
console.log(`[smoke] timeout=${TIMEOUT_MS}ms`);

const child = spawn(electronPath, [mainEntry, '--disable-gpu', '--no-sandbox'], {
  cwd: projectRoot,
  env: { ...process.env, IRIS_SMOKE: '1', FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

child.stdout.on('data', (c) => inspectChunk(c, 'stdout'));
child.stderr.on('data', (c) => inspectChunk(c, 'stderr'));

child.on('error', (err) => {
  finish(false, `spawn failed: ${err.message}`);
});

child.on('exit', (code, signal) => {
  if (resolved) return;
  finish(false, `child exited early code=${code} signal=${signal}`);
});

timeoutHandle = setTimeout(() => {
  if (!milestoneSeen) {
    finish(false, `no "bootstrap starting" within ${TIMEOUT_MS}ms — main never came up`);
    return;
  }
  if (fatalMessage) {
    finish(false, fatalMessage);
    return;
  }
  finish(true, `main up within ${TIMEOUT_MS}ms with no fatal errors`);
}, TIMEOUT_MS);
