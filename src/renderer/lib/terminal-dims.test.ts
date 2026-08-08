import { describe, expect, it } from 'vitest';
import {
  getLastTerminalDims,
  setLastTerminalDims,
  terminalLayoutScope,
  type TerminalLayoutScope,
} from '@renderer/stores/session-store';

const rootHub: TerminalLayoutScope = { kind: 'root-hub' };
const docRightPane: TerminalLayoutScope = { kind: 'doc-right-pane' };

describe('terminal dimension history', () => {
  it('does not reuse narrow doc-pane dimensions for a new root terminal', () => {
    setLastTerminalDims('C:\\projects\\alpha', docRightPane, { cols: 52, rows: 20 });

    expect(getLastTerminalDims('C:\\projects\\alpha', rootHub)).toEqual({ cols: 120, rows: 30 });
    expect(getLastTerminalDims('C:\\projects\\alpha', docRightPane)).toEqual({
      cols: 52,
      rows: 20,
    });
  });

  it('isolates projects and individual workspace hubs', () => {
    const alphaWorkspace: TerminalLayoutScope = {
      kind: 'workspace-hub',
      workspacePath: '.iris/issue/alpha',
    };
    const betaWorkspace: TerminalLayoutScope = {
      kind: 'workspace-hub',
      workspacePath: '.iris/issue/beta',
    };
    setLastTerminalDims('C:\\projects\\alpha', alphaWorkspace, { cols: 180, rows: 44 });

    expect(getLastTerminalDims('C:\\projects\\alpha', alphaWorkspace)).toEqual({
      cols: 180,
      rows: 44,
    });
    expect(getLastTerminalDims('C:\\projects\\alpha', betaWorkspace)).toEqual({
      cols: 120,
      rows: 30,
    });
    expect(getLastTerminalDims('C:\\projects\\beta', alphaWorkspace)).toEqual({
      cols: 120,
      rows: 30,
    });
  });

  it('derives the layout scope from the immutable session anchor', () => {
    expect(terminalLayoutScope({ docPath: '.iris/issue/task.md', workspacePath: null })).toEqual(
      docRightPane,
    );
    expect(terminalLayoutScope({ docPath: null, workspacePath: '.iris' })).toEqual(rootHub);
    expect(terminalLayoutScope({ docPath: null, workspacePath: '.iris/report/archive' })).toEqual({
      kind: 'workspace-hub',
      workspacePath: '.iris/report/archive',
    });
  });
});
