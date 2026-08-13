import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const workerPath = resolve('out/main/agent-worker.js');
await access(workerPath);

const probe = `
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(${JSON.stringify(workerPath)});
  const timeout = setTimeout(() => {
    console.error('agent worker check timed out');
    process.exit(2);
  }, 10000);
  worker.once('error', (error) => {
    console.error(error);
    process.exit(3);
  });
  worker.once('message', async (message) => {
    clearTimeout(timeout);
    console.log(JSON.stringify(message));
    await worker.terminate();
  });
  worker.postMessage({
    version: 1,
    type: 'initialize',
    correlation: { sessionId: 'runtime-check' },
    history: {
      revision: 7,
      anchor: { kind: 'workspace', path: '.iris' },
      messages: [],
    },
  });
`;

const result = await new Promise((resolveResult, reject) => {
  const child = spawn(electronPath, ['-e', probe], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.once('error', reject);
  child.once('exit', (code) => resolveResult({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
});

if (result.code !== 0) {
  throw new Error(`Electron Agent Worker check failed (${result.code}): ${result.stderr}`);
}
const event = JSON.parse(result.stdout);
if (
  event.version !== 1 ||
  event.type !== 'ready' ||
  event.correlation?.sessionId !== 'runtime-check' ||
  event.runtime?.piVersion !== '0.84.1' ||
  event.runtime?.historyRevision !== 7
) {
  throw new Error(`Unexpected Agent Worker response: ${result.stdout}`);
}

console.log(
  `[agent-worker] Electron Node ${event.runtime.nodeVersion}, Pi ${event.runtime.piVersion}, protocol v${event.version}`,
);

