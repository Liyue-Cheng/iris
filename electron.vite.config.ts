/**
 * @file electron.vite.config.ts
 * @purpose electron-vite config for the three processes (main / preload /
 *   renderer). Scaffold ported from Marina (E:\projects\terminal).
 *
 * Key points:
 * - Entries: src/main/index.ts, src/preload/index.ts, src/renderer/index.html
 * - Shared types live in src/shared/, exposed via the @shared/* alias
 * - main / preload run in Node (native deps externalized); renderer in browser
 * - Dev port is probed at config-load time: Windows Hyper-V/WinNAT reserves
 *   large port ranges and Vite only auto-falls-back on EADDRINUSE, not EACCES,
 *   so we pick a bindable port ourselves (logic ported verbatim from Marina).
 */
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/** Probe whether a port is bindable on 127.0.0.1 (short-lived child process). */
function tryListen(port: number): boolean {
  const script = `
    const net = require('net');
    const srv = net.createServer();
    let done = false;
    srv.once('error', () => { if (!done) { done = true; process.exit(1); } });
    srv.once('listening', () => {
      if (done) return;
      done = true;
      srv.close(() => process.exit(0));
    });
    srv.listen(${port}, '127.0.0.1');
    setTimeout(() => { if (!done) { done = true; process.exit(2); } }, 400);
  `;
  try {
    execFileSync(process.execPath, ['-e', script], {
      stdio: 'ignore',
      timeout: 1500,
    });
    return true;
  } catch {
    return false;
  }
}

/** Pick the first bindable port from candidates spread across ranges that
 *  rarely collide with Win11 excluded port ranges. Override: IRIS_DEV_PORT. */
function pickDevPort(): number {
  const override = Number(process.env.IRIS_DEV_PORT);
  if (override) {
    if (tryListen(override)) return override;
    console.warn(
      `[electron-vite] IRIS_DEV_PORT=${override} is not bindable (reserved or in use), falling back to candidates`,
    );
  }
  const candidates = [17273, 9273, 7273, 3273, 8273, 5173];
  for (const p of candidates) {
    if (tryListen(p)) return p;
  }
  console.warn(
    `[electron-vite] no candidate port bindable — check \`netsh interface ipv4 show excludedportrange protocol=tcp\` and set IRIS_DEV_PORT`,
  );
  return candidates[0]!;
}

const DEV_SERVER_PORT = pickDevPort();

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    build: {
      // Absolute path: a relative outDir would be resolved against the
      // renderer root's parent chain and can escape the project dir (this
      // bit Marina once — renderer output landed outside the repo).
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
    server: {
      // Pin IPv4: default localhost may resolve to ::1 first and hit
      // Windows IPv6 reserved-port EACCES.
      host: '127.0.0.1',
      port: DEV_SERVER_PORT,
      // We already probed the port; fail loudly instead of silently moving.
      strictPort: true,
    },
  },
});
