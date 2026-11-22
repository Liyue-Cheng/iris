import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '@shared/protocol';
import type { DocContent, DocumentSessionTarget } from '@shared/types';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  confirm: vi.fn(),
  editorGet: vi.fn(),
  readDoc: vi.fn(),
  invoke: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock('@renderer/cpu', () => ({ pipeline: { dispatch: mocks.dispatch } }));
vi.mock('@renderer/components/ui/confirm-dialog', () => ({
  confirmDialog: mocks.confirm,
}));
vi.mock('@renderer/stores/editor-store', () => ({
  editorStore: {
    get: mocks.editorGet,
    setFrontmatterField: vi.fn(),
    flushBeforeSwitch: vi.fn(),
  },
  readDocFromDisk: mocks.readDoc,
}));
vi.mock('@renderer/i18n', () => ({ translate: (key: string) => key }));
vi.mock('@renderer/stores/settings-store', () => ({ getSettings: mocks.getSettings }));

import { setDocsStatus } from './issue-actions';
import { projectScopeState } from '@renderer/stores/project-scope-state';

const ISSUE_PATH = '.iris/issue/example.md';

function content(status = 'In Progress'): DocContent {
  const raw = `---\ntitle: Example\nstatus: ${status}\n---\n\n- [ ] Verify\n`;
  return {
    path: ISSUE_PATH,
    raw,
    body: '\n- [ ] Verify\n',
    frontmatter: { title: 'Example', status },
    frontmatterBroken: false,
  };
}

const linked: DocumentSessionTarget = { kind: 'terminal', label: 'Shell', id: 'linked', documentPath: ISSUE_PATH };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
  mocks.editorGet.mockReturnValue(null);
  mocks.readDoc.mockResolvedValue(content());
  mocks.invoke.mockReset().mockResolvedValue([linked]);
  vi.stubGlobal('window', { api: { invoke: mocks.invoke } });
  mocks.getSettings.mockReturnValue({ behavior: { autoCheckTodosOnDone: true } });
});

describe('issue status actions', () => {
  it('retires a confirmation from the previous project before closing sessions or saving', async () => {
    projectScopeState.set({ root: 'C:/a', generation: 1 });
    let confirm!: (accepted: boolean) => void;
    mocks.confirm.mockReturnValueOnce(new Promise<boolean>((resolve) => { confirm = resolve; }));
    const work = setDocsStatus([ISSUE_PATH], 'On Hold');
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    projectScopeState.set({ root: 'C:/b', generation: 2 });
    confirm(true);
    expect(await work).toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    projectScopeState.set(null);
  });
  it('closes every linked terminal before saving On Hold', async () => {
    await setDocsStatus([ISSUE_PATH], 'On Hold');

    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(CHANNELS.DOCUMENT_SESSIONS_CLOSE, {
      expectedScope: null, documentPaths: [ISSUE_PATH], confirmed: [linked],
    });
    expect(mocks.dispatch).toHaveBeenNthCalledWith(
      1,
      'doc.save',
      expect.objectContaining({
        path: ISSUE_PATH,
        content: expect.stringContaining('status: On Hold'),
      }),
    );
    const saved = mocks.dispatch.mock.calls[0]![1] as { content: string };
    expect(saved.content).toContain('- [ ] Verify');
  });

  it('keeps automatic checkbox completion exclusive to Done', async () => {
    mocks.invoke.mockResolvedValue([]);

    await setDocsStatus([ISSUE_PATH], 'Done');

    const saved = mocks.dispatch.mock.calls[0]![1] as { content: string };
    expect(saved.content).toContain('status: Done');
    expect(saved.content).toContain('- [x] Verify');
  });

  it('does not change status when linked-terminal closure is rejected', async () => {
    mocks.confirm.mockResolvedValue(false);

    await setDocsStatus([ISSUE_PATH], 'On Hold');

    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('does not write Done when authoritative Agent archival fails', async () => {
    mocks.invoke.mockResolvedValue([]);
    mocks.invoke.mockResolvedValueOnce([{ ...linked, kind: 'iris-agent' }]).mockRejectedValueOnce(new Error('archive failed'));

    await expect(setDocsStatus([ISSUE_PATH], 'Done')).rejects.toThrow('archive failed');

    expect(mocks.dispatch).not.toHaveBeenCalledWith(
      'doc.save',
      expect.objectContaining({ path: ISSUE_PATH }),
    );
  });
  it('keeps the approved set empty when a terminal appears after the preview', async () => {
    mocks.invoke.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('LinkedSessionsChanged'));
    await expect(setDocsStatus([ISSUE_PATH], 'Done')).rejects.toThrow('LinkedSessionsChanged');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenLastCalledWith(CHANNELS.DOCUMENT_SESSIONS_CLOSE, {
      expectedScope: null, documentPaths: [ISSUE_PATH], confirmed: [],
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

});
