import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocContent } from '@shared/types';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  confirm: vi.fn(),
  editorGet: vi.fn(),
  readDoc: vi.fn(),
  sessionGet: vi.fn(),
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
vi.mock('@renderer/stores/session-store', () => ({
  sessionStore: { get: mocks.sessionGet },
}));
vi.mock('@renderer/i18n', () => ({ translate: (key: string) => key }));
vi.mock('@renderer/stores/settings-store', () => ({ getSettings: mocks.getSettings }));

import { setDocsStatus } from './issue-actions';

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
  mocks.editorGet.mockReturnValue(null);
  mocks.readDoc.mockResolvedValue(content());
  mocks.sessionGet.mockReturnValue({
    sessions: [{ id: 'linked', docPath: ISSUE_PATH }, { id: 'other', docPath: '.iris/issue/other.md' }],
  });
  mocks.getSettings.mockReturnValue({ behavior: { autoCheckTodosOnDone: true } });
});

describe('issue status actions', () => {
  it('closes every linked terminal before saving On Hold', async () => {
    await setDocsStatus([ISSUE_PATH], 'On Hold');

    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenNthCalledWith(1, 'session.close', { sessionId: 'linked' });
    expect(mocks.dispatch).toHaveBeenNthCalledWith(
      2,
      'doc.save',
      expect.objectContaining({
        path: ISSUE_PATH,
        content: expect.stringContaining('status: On Hold'),
      }),
    );
    const saved = mocks.dispatch.mock.calls[1]![1] as { content: string };
    expect(saved.content).toContain('- [ ] Verify');
  });

  it('keeps automatic checkbox completion exclusive to Done', async () => {
    mocks.sessionGet.mockReturnValue({ sessions: [] });

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
});
