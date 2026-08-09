/** @vitest-environment jsdom */
import { act, createElement, type PropsWithChildren } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IrisScanResult, ProjectSettingsSnapshot } from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import {
  hydrateProjectSettings,
  projectSettingsStore,
} from '@renderer/stores/project-settings-store';
import { projectISA } from '@renderer/cpu/isa/project-isa';
import { ProjectToolbarActions } from '@renderer/components/layout/LeftPane';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/lib/project-actions', () => ({
  openProject: vi.fn(),
  openProjectInNewWindow: vi.fn(),
  pickAndOpenProject: vi.fn(),
}));

vi.mock('@renderer/lib/project-command-actions', () => ({
  runProjectToolbarAction: vi.fn(),
}));

vi.mock('@renderer/components/lens/LensTree', () => ({ LensTree: () => null }));
vi.mock('@renderer/components/project/InitDialog', () => ({ InitDialog: () => null }));
vi.mock('@renderer/components/project/CreateWorkspaceDialog', () => ({
  CreateWorkspaceDialog: () => null,
}));
vi.mock('@renderer/components/git/SourceControlPanel', () => ({
  SourceControlPanel: () => null,
}));

vi.mock('@renderer/stores/git-store', () => ({
  gitStore: { refresh: vi.fn(), reset: vi.fn() },
  useGit: () => ({ snapshot: null, loading: false, pending: null }),
}));

vi.mock('@renderer/components/ui/tooltip', async () => {
  const React = await import('react');
  const PassThrough = ({ children }: PropsWithChildren) =>
    React.createElement(React.Fragment, null, children);
  return {
    Tooltip: PassThrough,
    TooltipContent: PassThrough,
    TooltipTrigger: PassThrough,
  };
});

vi.mock('@renderer/components/ui/dropdown-menu', async () => {
  const React = await import('react');
  const PassThrough = ({ children }: PropsWithChildren) =>
    React.createElement(React.Fragment, null, children);
  return {
    DropdownMenu: PassThrough,
    DropdownMenuContent: PassThrough,
    DropdownMenuItem: PassThrough,
    DropdownMenuLabel: PassThrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: PassThrough,
  };
});

vi.mock('@renderer/components/ui/lucide-dynamic-icon', async () => {
  const React = await import('react');
  return {
    isLucideIconName: (name: string) => name === 'rocket' || name === 'settings',
    LucideDynamicIcon: ({ name }: { name: string }) =>
      React.createElement('span', { 'data-icon': name }),
  };
});

function snapshot(description: string): ProjectSettingsSnapshot {
  return {
    settings: {
      version: 1,
    prompts: { project: '' },
    agentContext: { entries: ['AGENTS.md'] },
    toolbar: {
        actions: [{ icon: 'rocket', description, command: 'run', terminal: 'iris' }],
      },
    },
    revision: description.padEnd(64, 'a'),
    exists: true,
    diagnostics: [],
    error: null,
    trusted: false,
  };
}

beforeEach(() => {
  projectScopeState.set(null);
  projectSettingsStore.reset();
  vi.unstubAllGlobals();
});

describe('project settings store scope boundary', () => {
  it('hydrates settings for a restored active project scope', async () => {
    const scope = { root: 'E:\\project-a', generation: 1 };
    const invoke = vi.fn().mockResolvedValue(snapshot('restored'));
    vi.stubGlobal('window', { api: { invoke } });
    projectScopeState.set(scope);

    await hydrateProjectSettings();

    expect(invoke).toHaveBeenCalledWith(CHANNELS.PROJECT_SETTINGS_GET, {
      expectedScope: scope,
    });
    expect(projectSettingsStore.get().snapshot?.settings.toolbar.actions[0]?.description).toBe(
      'restored',
    );
  });

  it('ignores a refresh result after the active project changes', async () => {
    const scopeA = { root: 'E:\\project-a', generation: 1 };
    const scopeB = { root: 'E:\\project-b', generation: 2 };
    let resolveRequest!: (value: ProjectSettingsSnapshot) => void;
    const request = new Promise<ProjectSettingsSnapshot>((resolve) => {
      resolveRequest = resolve;
    });
    vi.stubGlobal('window', { api: { invoke: vi.fn(() => request) } });
    projectScopeState.set(scopeA);

    const refresh = projectSettingsStore.refresh(scopeA);
    projectScopeState.set(scopeB);
    projectSettingsStore.reset(scopeB);
    resolveRequest(snapshot('stale'));
    await refresh;

    expect(projectSettingsStore.get()).toMatchObject({ scope: scopeB, snapshot: null });
  });

  it('accepts a snapshot only for the active root and generation', () => {
    const active = { root: 'E:\\project-a', generation: 2 };
    projectScopeState.set(active);

    projectSettingsStore.handleSnapshot(snapshot('old'), { ...active, generation: 1 });
    expect(projectSettingsStore.get().snapshot).toBeNull();

    projectSettingsStore.handleSnapshot(snapshot('current'), active);
    expect(projectSettingsStore.get().snapshot?.settings.toolbar.actions[0]?.description).toBe(
      'current',
    );
  });

  it('installs the project-open snapshot without a follow-up settings request', async () => {
    const scope = { root: 'E:\\project-a', generation: 3 };
    const scan: IrisScanResult = {
      projectRoot: scope.root,
      projectName: 'project-a',
      hasIris: false,
      root: null,
      scannedAt: 1,
    };
    const invoke = vi.fn();
    vi.stubGlobal('window', { api: { invoke } });

    await projectISA['project.open']!.commit!(
      { scope, scan, sessions: [], projectSettings: snapshot('opened') },
      { root: scope.root },
      {} as never,
    );

    expect(projectSettingsStore.get()).toMatchObject({
      scope,
      snapshot: { settings: { toolbar: { actions: [{ description: 'opened' }] } } },
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('project toolbar settings lifecycle', () => {
  it('starts measuring when settings arrive after the initial render', async () => {
    const observed: Element[] = [];
    let disconnects = 0;
    class ResizeObserverMock {
      constructor(_callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        observed.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        disconnects += 1;
      }
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(96);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(createElement(ProjectToolbarActions)));
    expect(observed).toHaveLength(0);

    const scope = { root: 'E:\\project-a', generation: 4 };
    projectScopeState.set(scope);
    const loaded = snapshot('Run project');
    loaded.settings.toolbar.actions.push({
      icon: 'settings',
      description: 'Open tools',
      command: 'tools',
      terminal: 'system',
    });
    await act(async () => projectSettingsStore.install(loaded, scope));

    expect(observed).toHaveLength(1);
    expect(host.querySelector('[data-icon="rocket"]')).not.toBeNull();
    expect(host.querySelector('[data-icon="settings"]')).not.toBeNull();

    await act(async () => root.unmount());
    expect(disconnects).toBe(1);
    host.remove();
    width.mockRestore();
  });
});
