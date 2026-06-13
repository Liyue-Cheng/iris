/**
 * @file doc-isa.ts
 * @purpose `doc.*` instructions — the write path of documents.
 *
 * Iris deviations (technical-design.md):
 * - `doc.save` is SERIAL per `doc:{path}`: rapid saves of one doc queue,
 *   different docs run concurrently.
 * - No optimistic config (local disk has no latency to hide) and no cancel
 *   tags: front-cpu cancellation is cooperative — a "cancelled" write may
 *   still hit the disk, which is dirty semantics. We simply never cancel.
 * - The renderer composes the EXACT bytes (editor is the source of truth,
 *   updated before dispatch) — that's what makes the echo-dedup state
 *   compare race-free.
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';

export const docISA: Record<string, InstructionDefinition> = {
  'doc.save': {
    meta: {
      description: 'Write a document verbatim (atomic tmp+rename in main)',
      category: 'task',
      resourceIdentifier: (p: { path: string }) => [`doc:${p.path}`],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.DOC_WRITE },
  },

  'doc.delete': {
    meta: {
      description: 'Delete a document (human UI gesture; .iris/ markdown only)',
      category: 'task',
      // Same resource as doc.save: a queued save of this doc must not race
      // the unlink.
      resourceIdentifier: (p: { path: string }) => [`doc:${p.path}`],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.DOC_DELETE },
  },

  'doc.create': {
    meta: {
      description: 'Create a typed document (date-prefixed in issue/ and report/)',
      category: 'task',
      // Serialize per target folder so two quick creates probe names in order.
      resourceIdentifier: (p: { workspacePath: string; type: string }) => [
        `docdir:${p.workspacePath}/${p.type}`,
      ],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.DOC_CREATE },
  },
};
