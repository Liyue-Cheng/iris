import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quoteShellPath, terminalShellKindFromExecutable } from '@shared/terminal/shell-quoting';
import { createPlatformServices } from '../platform';
import { createTempDataDir, removeTempDataDir } from '../persistence';
import { AgentCommandPty } from './command-pty';

/** A bounded child owned exclusively by this test; no renderer or user PTY is involved. */
const PROBE = String.raw`
const queries = [
  ['DSR', '\x1b[6n', /\x1b\[\d+;\d+R/],
  ['DA', '\x1b[c', /\x1b\[\?[\d;]*c/],
  ['DECRQM', '\x1b[?2004$p', /\x1b\[\?2004;[0-4]\$y/],
  ['OSC10', '\x1b]10;?\x07', /\x1b\]10;rgb:[a-f\d/]+(?:\x1b\\|\x07)/i],
  ['OSC11', '\x1b]11;?\x07', /\x1b\]11;rgb:[a-f\d/]+(?:\x1b\\|\x07)/i],
  ['OSC4', '\x1b]4;1;?\x07', /\x1b\]4;1;rgb:[a-f\d/]+(?:\x1b\\|\x07)/i],
  ['SCHEME', '\x1b[?996n', /\x1b\[\?997;[12]n/],
  ['DECRQSS', '\x1bP$qm\x1b\\', /\x1bP[01]\$r[^\x1b]*\x1b\\/],
];
let received = '';
let pending = null;
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { received += data; if (pending) pending(); });
process.stdin.resume();
const deadline = setTimeout(() => finish(2, 'DEADLINE'), 15000);
function finish(code, message) {
  clearTimeout(deadline);
  process.stdin.pause();
  process.stdin.setRawMode(false);
  process.stdout.write('\r\nIRIS_NATIVE_' + message + '\r\n', () => process.exit(code));
}
async function ask(name, query, pattern) {
  received = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending = null;
      reject(new Error(name + '_MISSING_' + Buffer.from(received).toString('hex')));
    }, 1200);
    pending = () => {
      if (!pattern.test(received)) return;
      clearTimeout(timer);
      pending = null;
      resolve();
    };
    process.stdout.write(query);
  });
  process.stdout.write('\r\nIRIS_NATIVE_' + name + '_OK\r\n');
}
setTimeout(async () => {
  try {
    for (const [name, query, pattern] of queries) await ask(name, query, pattern);
    finish(0, 'COMPLETE');
  } catch (error) { finish(1, String(error.message)); }
}, 150);
`;

describe.runIf(process.platform === 'win32')('AgentCommandPty native Windows protocol replies', () => {
  it('answers supported queries through bundled ConPTY without any renderer attachment', async () => {
    const directory = await createTempDataDir('iris-native-terminal-protocol-');
    const script = join(directory, 'probe.cjs');
    const services = createPlatformServices();
    const shellKind = terminalShellKindFromExecutable(services.capabilities.shell.executable);
    const chunks: Buffer[] = [];
    let terminal: AgentCommandPty | undefined;
    try {
      await writeFile(script, PROBE, 'utf8');
      terminal = new AgentCommandPty({
        terminalId: 'native-protocol-probe',
        command: `${shellKind === 'powershell' ? '& ' : ''}${quoteShellPath(process.execPath, shellKind)} ${quoteShellPath(script, shellKind)}`,
        cwd: directory,
        outputPath: join(directory, 'probe.log'),
        timeoutMs: 20_000,
        processTreeKillFn: services.processTree.kill,
        outputStore: { append: async (_path, bytes) => { chunks.push(Buffer.from(bytes)); } },
        // Use the production spawn path, ConPTY selection and main-side parser.
        // There is deliberately no output listener, renderer, replay or manual reply.
      });
      const result = await terminal.result;
      expect(result.termination, result.plainText).toBeUndefined();
      expect(result.exitCode, result.plainText).toBe(0);
      for (const name of ['DSR', 'DA', 'DECRQM', 'OSC10', 'OSC11', 'OSC4', 'SCHEME', 'DECRQSS']) {
        expect(result.plainText).toContain(`IRIS_NATIVE_${name}_OK`);
      }
      expect(result.plainText).toContain('IRIS_NATIVE_COMPLETE');
      expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
    } finally {
      terminal?.abort();
      await terminal?.result.catch(() => undefined);
      terminal?.dispose();
      await removeTempDataDir(directory);
    }
  }, 30_000);
});
