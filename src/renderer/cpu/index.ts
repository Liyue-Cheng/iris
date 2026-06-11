/**
 * @file cpu/index.ts
 * @purpose Pipeline instantiation — the project integration layer for
 *   front-cpu (structure mirrors cutie's src/cpu/index.ts).
 *
 * Iris deviations from cutie (technical-design.md 复用 front-cpu):
 * - `ipc` executor instead of an HTTP client (no backend; setHttpClient unused)
 * - instance-level dependency injection only, no global registries —
 *   unit-test isolation comes free
 * - optimistic updates are never configured (local disk writes have no
 *   latency to hide)
 */
import { Pipeline } from 'front-cpu';
import { ISA } from './isa';
import { correlationIdAdapter } from './cpu-adapters/correlation-id-adapter';
import { createReactiveState } from './cpu-adapters/reactive-state-factory';
import { ipcExecutor } from './cpu-adapters/ipc-executor';

export const pipeline = new Pipeline({
  tickInterval: 16,
  maxConcurrency: 10,
  isa: ISA,
  executors: { ipc: ipcExecutor },
  correlationIdGenerator: correlationIdAdapter,
  reactiveStateFactory: createReactiveState,
});

pipeline.start();

export { ISA };
export { useReactiveState } from './cpu-adapters/reactive-state-factory';

// Dev console handle (pattern from cutie).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).cpuPipeline = {
    pipeline,
    dispatch: (type: string, payload: unknown) => pipeline.dispatch(type, payload),
    getStatus: () => pipeline.getStatus(),
  };
}
