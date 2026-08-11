import { describe, expect, it } from 'vitest';
import { defaultProcessTreeKiller, killWindowsProcessTree } from './process-tree';

describe('process tree policy', () => {
  it('only installs the taskkill adapter on Windows', () => {
    expect(defaultProcessTreeKiller('linux')).toBeNull();
    expect(defaultProcessTreeKiller('win32')).toBe(killWindowsProcessTree);
  });
});
