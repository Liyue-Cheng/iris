import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const workerPath = resolve('out/main/agent-worker.js');
await access(workerPath);

const history = {
  revision: 7,
  anchor: { kind: 'workspace', path: '.iris' },
  messages: [],
};

function historyDigest(value) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const probe = `
  const { Worker } = require('node:worker_threads');
  const { mkdtempSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const agentDir = mkdtempSync(join(tmpdir(), 'iris-agent-worker-check-'));
  const worker = new Worker(${JSON.stringify(workerPath)});
  const timeout = setTimeout(() => {
    console.error('agent worker check timed out');
    process.exit(2);
  }, 10000);
  worker.once('error', (error) => {
    console.error(error);
    process.exit(3);
  });
  worker.on('message', async (message) => {
    if (message && message.type !== 'ready') return;
    clearTimeout(timeout);
    console.log(JSON.stringify(message));
    await worker.terminate();
    rmSync(agentDir, { recursive: true, force: true });
  });
  worker.postMessage({
    version: 3,
    type: 'initialize',
    correlation: { sessionId: 'runtime-check', workerEpoch: 4 },
    history: ${JSON.stringify(history)},
    runtime: {
      cwd: process.cwd(),
      agentDir,
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
  event.version !== 3 ||
  event.type !== 'ready' ||
  event.correlation?.sessionId !== 'runtime-check' ||
  event.correlation?.workerEpoch !== 4 ||
  event.runtime?.protocolVersion !== 3 ||
  event.runtime?.piVersion !== '0.84.1' ||
  event.runtime?.workerEpoch !== 4 ||
  event.runtime?.historyRevision !== 7 ||
  event.runtime?.historyMessageCount !== 0 ||
  event.runtime?.historyDigest !== historyDigest(history)
) {
  throw new Error(`Unexpected Agent Worker response: ${result.stdout}`);
}

console.log(
  `[agent-worker] Electron Node ${event.runtime.nodeVersion}, Pi ${event.runtime.piVersion}, protocol v${event.version}`,
);
