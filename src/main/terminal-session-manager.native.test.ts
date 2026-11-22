import { expect, it, vi } from 'vitest';
import type { SettingsManager } from './settings-manager';
import { TerminalSessionManager } from './terminal-session-manager';

it.runIf(process.platform === 'win32')('restores the same native shell after a detached write and retains its exit', async () => {
  const manager = new TerminalSessionManager({ get: () => ({
    agents: [{ id: 'shell', label: 'Shell', command: '' }],
    advanced: { activeIdleThresholdSeconds: 2 }, appearance: { theme: 'rose-pine' },
  }) } as unknown as SettingsManager);
  try {
    const session = manager.createSession({
      docPath: null, agentId: 'shell', projectRoot: process.cwd(), projectGeneration: 1, cols: 90, rows: 25,
    });
    const write = (text: string) => manager.sendInput(session.id, Buffer.from(text + '\r').toString('base64'));
    manager.attachOutput(session.id, 'first');
    expect(manager.resize(session.id, 100, 30).accepted).toBe(true);
    manager.detachOutput('first');
    const command = session.shellKind === 'cmd' ? 'echo IRIS_^RESTORED' : "Write-Output ('IRIS_' + 'RESTORED')";
    expect(write(command).accepted).toBe(true);
    manager.attachOutput(session.id, 'restored');
    await vi.waitFor(async () => {
      const replay = await manager.prepareReplay(session.id, 100, 30);
      expect(Buffer.from(replay.data, 'base64').toString()).toContain('IRIS_RESTORED');
    }, { timeout: 12000, interval: 150 });
    expect(manager.get(session.id)?.pid).toBe(session.pid);
    expect(write('exit 17').accepted).toBe(true);
    await vi.waitFor(() => expect(manager.get(session.id)).toMatchObject({ state: 'exited', exitCode: 17 }), { timeout: 8000 });
    expect(write('a')).toMatchObject({ accepted: false, reason: 'pty-exited' });
  } finally { await manager.shutdown(); }
}, 28000);
