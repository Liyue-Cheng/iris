/**
 * @file isa/index.ts
 * @purpose The complete Iris instruction set. One file per domain
 *   (`{domain}-isa.ts`), merged here. New feature = new instruction —
 *   `grep registerISA`-able, single chokepoint for every side effect.
 */
import type { InstructionDefinition } from 'front-cpu';
import { appISA } from './app-isa';
import { settingsISA } from './settings-isa';

export const ISA: Record<string, InstructionDefinition> = {
  ...appISA,
  ...settingsISA,
};
