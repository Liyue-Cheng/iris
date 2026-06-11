/**
 * CorrelationId generator adapter (pattern from cutie's correlationIdAdapter).
 * Iris has no separate correlation infra yet — crypto.randomUUID is enough;
 * the ids matter from M2 on, when file-watcher interrupts need to correlate
 * with locally dispatched writes.
 */
import type { ICorrelationIdGenerator } from 'front-cpu';

export const correlationIdAdapter: ICorrelationIdGenerator = {
  generate: () => crypto.randomUUID(),
};
