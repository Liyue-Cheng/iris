import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    environment: 'node',
    // Bound simultaneous TypeScript transforms, filesystem fixtures and native
    // processes so machines with many logical CPUs do not exhaust memory/I/O.
    minWorkers: 1,
    maxWorkers: 4,
    // The suite includes real Git/PTY processes and durable filesystem writes.
    // Keep a bounded timeout without assuming they finish within five seconds.
    testTimeout: 15_000,
    include: [
      'src/main/**/*.test.ts',
      'src/shared/**/*.test.ts',
      'src/renderer/lib/**/*.test.ts',
      'src/renderer/terminal/**/*.test.ts',
    ],
    server: {
      // The published ESM currently uses extensionless relative imports.
      // Let Vite resolve them instead of externalizing the package to Node.
      deps: {
        inline: ['front-cpu'],
      },
    },
  },
});
