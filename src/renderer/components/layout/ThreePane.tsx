/**
 * The shell (software-definition.md §5 界面):
 *   left   — lens-organized document tree (M1)
 *   middle — collection views / single-doc editor (M2/M4)
 *   right  — session panel, vertical AI conversations (M3)
 *
 * Outside a document collection browser, the LEFT pane lives in ONE stable
 * outer panel group (autoSaveId
 * "iris-shell") that never remounts on a view switch — otherwise每切一次
 * view.kind 就换一整个 PanelGroup，左栏被迫套用那个组自己的宽度，点终端条
 * （root 视图）左宽就会跳。Only the RIGHT area's content swaps by view:
 * full-width terminal (root), editor+terminal split (doc), or a full-width
 * manager (todos). A document collection is a separate two-pane shell
 * so the global tree and terminal do not compete with its list and editor.
 *
 * Visual style is a setting (appearance.paneStyle, issue 2026-10-22-优化界面):
 * 'cards' draws three equal rounded cards on the bg-card backdrop; 'layered'
 * puts every view on one base sheet (bg-shell, shared with the title bar) —
 * tree / document / list columns split by a hairline, and only the detail
 * column (the terminal, or the document beside a collection list) raised.
 */
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable';
import { LeftPane } from '@renderer/components/layout/LeftPane';
import { MiddlePane } from '@renderer/components/layout/MiddlePane';
import { RightPane } from '@renderer/components/layout/RightPane';
import { DocView } from '@renderer/components/doc/DocView';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { projectStore, useProject, type MiddleView } from '@renderer/stores/project-store';
import { usePaneStyle } from '@renderer/stores/settings-store';
import type { PaneStyle } from '@shared/types';

function PaneViewport({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      data-pane-viewport
      className={cn('h-full min-h-0 min-w-0 overflow-hidden', className)}
    >
      {children}
    </div>
  );
}

/** One column's visual frame (settings: appearance.paneStyle).
 *  - 'cards': every column is an equal rounded card on the bg-card backdrop.
 *  - 'layered': 'flat' columns sit directly on the shared base sheet; the
 *    'raised' column is inset from the window edges on top / right / bottom,
 *    flush toward the resize lane on the left.
 *  Both styles and both roles render the SAME element tree — only classes
 *  change — so toggling the setting or a column's role never remounts a live
 *  terminal inside. */
function PaneFrame({
  paneStyle,
  role,
  cardClassName = 'rounded-lg',
  children,
}: {
  paneStyle: PaneStyle;
  role: 'flat' | 'raised';
  cardClassName?: string;
  children: ReactNode;
}): JSX.Element {
  const layered = paneStyle === 'layered';
  const raised = layered && role === 'raised';
  return (
    <div className={cn('h-full min-h-0 min-w-0', raised && 'py-1.5 pr-1.5')}>
      <div
        className={cn(
          'h-full min-h-0 min-w-0 overflow-hidden',
          !layered && cn(cardClassName, 'bg-background shadow-sm'),
          raised && 'iris-raised-pane',
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Backdrop behind the columns: the card gutter, or the layered base sheet. */
function backdropClass(paneStyle: PaneStyle): string {
  return paneStyle === 'layered' ? 'bg-shell' : 'bg-card';
}

/** Resize handle between two columns. In the layered style two flat columns
 *  share the base sheet and need a visible hairline; next to a raised column
 *  (or between cards) the frame edge already separates them. */
function seamClass(paneStyle: PaneStyle, bothFlat: boolean): string {
  return paneStyle === 'layered' && bothFlat ? 'after:bg-border' : '';
}

/** The right area — its content depends on the view, but the left pane's
 *  width never does (the left lives in the stable outer group above). */
function RightArea({ view }: { view: MiddleView }): JSX.Element {
  // Collection / todo views keep the manager at full width.
  if (view.kind === 'collection' || view.kind === 'todos') {
    return <MiddlePane />;
  }

  // Doc (editor + terminal split) and hub (terminal-only) views share ONE
  // panel group with a STABLE RightPane panel. If RightPane changed tree
  // position/type between views (as it used to — wrapped in a group for doc,
  // bare for hub), React would unmount+remount it on every cross-view switch,
  // needlessly tearing down the live xterm and re-replaying even when the same
  // session stays anchored. The editor panel only renders for doc view;
  // RightPane keeps the same id/position either way, so its terminal survives a
  // doc↔hub switch. (Same philosophy as the LeftPane staying in the stable
  // outer group.)
  const isDoc = view.kind === 'doc';
  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="iris-doc-split">
      {isDoc && (
        <>
          <ResizablePanel id="doc-editor" order={1} defaultSize={64} minSize={30}>
            <MiddlePane />
          </ResizablePanel>
          <ResizableHandle />
        </>
      )}
      <ResizablePanel id="doc-terminal" order={2} defaultSize={isDoc ? 36 : 100} minSize={20}>
        <RightPane />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function DocumentCollectionShell({ paneStyle }: { paneStyle: PaneStyle }): JSX.Element {
  const { t } = useTranslation();
  const returnToMain = (): void => {
    const view = projectStore.get().view;
    if (view.kind !== 'collection') return;
    const entryType = view.returnEntry.type;
    const entryWorkspace = view.returnEntry.workspacePath ?? '.iris';
    void projectStore.leaveCollection().then((left) => {
      if (!left) return;
      requestAnimationFrame(() => {
        const entries = document.querySelectorAll<HTMLButtonElement>(
          '[data-collection-entry-type]',
        );
        for (const entry of entries) {
          if (
            entry.dataset.collectionEntryType === entryType &&
            entry.dataset.collectionEntryWorkspace === entryWorkspace
          ) {
            entry.focus();
            break;
          }
        }
      });
    });
  };
  return (
    <ResizablePanelGroup
      direction="horizontal"
      autoSaveId="iris-document-collection"
      className={cn('min-w-0 overflow-hidden', backdropClass(paneStyle))}
    >
      <ResizablePanel id="collection-list" order={1} defaultSize={40} minSize={28} maxSize={58} className="overflow-hidden">
        <PaneFrame paneStyle={paneStyle} role="flat" cardClassName="rounded-xl">
          <PaneViewport className="relative pr-1">
            <MiddlePane />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="absolute bottom-3 left-3 z-20 h-8 w-8 shadow-sm"
                  aria-label={t('collection.backToMain')}
                  onClick={returnToMain}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t('collection.backToMain')}</TooltipContent>
            </Tooltip>
          </PaneViewport>
        </PaneFrame>
      </ResizablePanel>
      <ResizableHandle className={seamClass(paneStyle, false)} />
      <ResizablePanel id="collection-document" order={2} defaultSize={60} minSize={38} className="overflow-hidden">
        <PaneFrame paneStyle={paneStyle} role="raised" cardClassName="rounded-xl">
          <PaneViewport>
            <DocView />
          </PaneViewport>
        </PaneFrame>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export function ThreePane(): JSX.Element {
  const { view } = useProject();
  const paneStyle = usePaneStyle();

  if (view.kind === 'collection') {
    return <DocumentCollectionShell paneStyle={paneStyle} />;
  }

  if (view.kind === 'doc') {
    return (
      <ResizablePanelGroup direction="horizontal" autoSaveId="iris-shell" className={backdropClass(paneStyle)}>
        <ResizablePanel defaultSize={25} minSize={12} maxSize={40} className="p-0">
          <PaneFrame paneStyle={paneStyle} role="flat">
            <LeftPane />
          </PaneFrame>
        </ResizablePanel>
        <ResizableHandle className={seamClass(paneStyle, true)} />
        <ResizablePanel id="doc-editor" order={2} defaultSize={48} minSize={24} className="p-0">
          <PaneFrame paneStyle={paneStyle} role="flat">
            <MiddlePane />
          </PaneFrame>
        </ResizablePanel>
        <ResizableHandle className={seamClass(paneStyle, false)} />
        <ResizablePanel id="doc-terminal" order={3} defaultSize={27} minSize={18} className="p-0">
          <PaneFrame paneStyle={paneStyle} role="raised">
            <RightPane />
          </PaneFrame>
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  // Hub views lift their full-width terminal; the todo manager stays flat on
  // the sheet like any other list.
  const rightRole = view.kind === 'todos' ? 'flat' : 'raised';
  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="iris-shell" className={backdropClass(paneStyle)}>
      <ResizablePanel defaultSize={25} minSize={12} maxSize={40} className="p-0">
        <PaneFrame paneStyle={paneStyle} role="flat">
          <LeftPane />
        </PaneFrame>
      </ResizablePanel>
      <ResizableHandle className={seamClass(paneStyle, rightRole === 'flat')} />
      <ResizablePanel defaultSize={75} minSize={30} className="p-0">
        <PaneFrame paneStyle={paneStyle} role={rightRole}>
          <RightArea view={view} />
        </PaneFrame>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
