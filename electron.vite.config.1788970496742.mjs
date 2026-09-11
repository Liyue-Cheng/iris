// electron.vite.config.ts
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
function tryListen(port) {
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
    execFileSync(process.execPath, ["-e", script], {
      stdio: "ignore",
      timeout: 1500
    });
    return true;
  } catch {
    return false;
  }
}
function pickDevPort() {
  const override = Number(process.env.IRIS_DEV_PORT);
  if (override) {
    if (tryListen(override)) return override;
    console.warn(
      `[electron-vite] IRIS_DEV_PORT=${override} is not bindable (reserved or in use), falling back to candidates`
    );
  }
  const candidates = [17273, 9273, 7273, 3273, 8273, 5173];
  for (const p of candidates) {
    if (tryListen(p)) return p;
  }
  console.warn(
    `[electron-vite] no candidate port bindable \u2014 check \`netsh interface ipv4 show excludedportrange protocol=tcp\` and set IRIS_DEV_PORT`
  );
  return candidates[0];
}
var DEV_SERVER_PORT = pickDevPort();
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@main": resolve("src/main")
      }
    },
    build: {
      outDir: "out/main",
      rollupOptions: {
        // Two entries: `index` is the featherweight single-instance gate; the
        // single-instance loser loads nothing else. `app-main` is the real
        // backend, lazily imported by the winner. Naming it as an entry (rather
        // than letting it fall out as a hashed chunk under chunks/) keeps it at
        // out/main/app-main.js, so app-main's __dirname stays out/main and its
        // '../preload' / '../renderer' relative paths resolve correctly.
        input: {
          index: resolve("src/main/index.ts"),
          "app-main": resolve("src/main/app-main.ts"),
          "agent-worker": resolve("src/main/agent-worker.ts")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared")
      }
    },
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") }
      }
    }
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@renderer": resolve("src/renderer")
      }
    },
    build: {
      // Absolute path: a relative outDir would be resolved against the
      // renderer root's parent chain and can escape the project dir (this
      // bit Marina once — renderer output landed outside the repo).
      outDir: resolve("out/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve("src/renderer/index.html") }
      }
    },
    server: {
      // Pin IPv4: default localhost may resolve to ::1 first and hit
      // Windows IPv6 reserved-port EACCES.
      host: "127.0.0.1",
      port: DEV_SERVER_PORT,
      // We already probed the port; fail loudly instead of silently moving.
      strictPort: true
    }
  }
});
export {
  electron_vite_config_default as default
};
