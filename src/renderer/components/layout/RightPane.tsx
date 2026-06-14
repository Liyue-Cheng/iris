/**
 * Right pane — the session panel (软件定义书 §5 右栏). Sessions anchor to
 * docs; the project-root session is the unfocused fallback. Detach, not
 * dispatch: sessions stay interactive, the user walks away and comes back.
 *
 * Round-3 E-1/E-2 form: the pane shows ONLY the sessions of the middle
 * pane's anchor — the selected doc's sessions, or the project-root sessions
 * when the root node is selected (no mixing). The old session tab strip is
 * gone; the header is a terminal BANNER: click to switch between this
 * anchor's sessions (close lives in that menu), + on the right to spawn a
 * new one. No session under the anchor → a full-page launch pad (Marina 式
 * EmptyPathState, F-1): spawn happens only on an explicit click.
 */
import { ChevronDown, Plus, X, FileText, FolderRoot, SquareTerminal } from 'lucide-react';
import { useSessions, sessionStore } from '@renderer/stores/session-store';
import { useSettings } from '@renderer/stores/settings-store';
import { useProject } from '@renderer/stores/project-store';
import { closeSession, openSession } from '@renderer/lib/session-actions';
import { docDisplayTitle, findDocByPath } from '@renderer/lib/doc-utils';
import { TerminalView } from '@renderer/components/terminal/TerminalView';
import { Button } from '@renderer/components/ui/button';
import { SessionDot } from '@renderer/components/ui/session-dot';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';

export function RightPane(): JSX.Element {
  const { sessions, activeSessionId } = useSessions();
  const settings = useSettings();
  const { phase, selectedPath, view, scan } = useProject();
  const agents = settings?.agents ?? [];
  const projectReady = phase === 'ready';

  // The pane's anchor mirrors the middle pane: a selected doc, or the
  // project root (root node selected / nothing selected yet).
  const anchor: string | null = view.kind === 'root' ? null : selectedPath;
  // D5: show the doc's display title (frontmatter title), not the filename.
  const anchorDoc = anchor && scan?.root ? findDocByPath(scan.root, anchor) : null;
  const anchorName = anchor
    ? anchorDoc
      ? docDisplayTitle(anchorDoc)
      : (anchor.split('/').pop()?.replace(/\.md$/i, '') ?? anchor)
    : '项目根';
  const AnchorIcon = anchor ? FileText : FolderRoot;

  const visibleSessions = sessions.filter((s) => s.docPath === anchor);
  // Never show a terminal whose session is outside the current anchor; if
  // the staged id points elsewhere but this anchor HAS sessions, fall back
  // to the newest one (display-level only — no state mutation in render).
  const shownSession =
    visibleSessions.find((s) => s.id === activeSessionId) ??
    visibleSessions[visibleSessions.length - 1] ??
    null;

  return (
    <div className="flex h-full flex-col bg-card/50">
      {/* Terminal banner — aligned (h-9) with the other panes' first rows. */}
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        {shownSession ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex min-w-0 flex-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      title="切换该锚点下的会话（右键可关闭）"
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[13px] hover:bg-muted/60"
                    >
                      <SessionDot state={shownSession.state} />
                      {/* Title bar shows the live terminal title (OSC 0/2),
                          falling back to the agent label until one arrives.
                          The agent identity stays available in the dropdown,
                          so the title bar shows only the live title. */}
                      <span className="min-w-0 truncate font-medium">
                        {shownSession.terminalTitle ?? shownSession.displayName}
                      </span>
                      {shownSession.state === 'exited' && (
                        <span className="shrink-0 text-[11px] text-muted-foreground/60">
                          exit {shownSession.exitCode}
                        </span>
                      )}
                      {visibleSessions.length > 1 && (
                        <span className="shrink-0 text-[11px] text-muted-foreground/60">
                          {visibleSessions.indexOf(shownSession) + 1}/{visibleSessions.length}
                        </span>
                      )}
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-max min-w-64 max-w-[32rem]"
                  >
                    <DropdownMenuLabel className="truncate">
                      {anchorName} 的会话
                    </DropdownMenuLabel>
                    {visibleSessions.map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        onClick={() => sessionStore.select(s.id)}
                        className="flex items-center gap-1.5"
                      >
                        <SessionDot state={s.state} />
                        <span className="shrink-0 font-medium">{s.displayName}</span>
                        {s.terminalTitle && (
                          <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
                            {s.terminalTitle}
                          </span>
                        )}
                        {s.state === 'exited' && (
                          <span className="shrink-0 text-[11px] text-muted-foreground/60">
                            exit {s.exitCode}
                          </span>
                        )}
                        {s.id === shownSession.id && (
                          <span className="shrink-0 text-[11px] text-muted-foreground/60">当前</span>
                        )}
                        <button
                          type="button"
                          title="关闭会话"
                          onClick={(e) => {
                            e.stopPropagation();
                            void closeSession(s.id);
                          }}
                          className="ml-auto shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => void closeSession(shownSession.id)}>
                关闭会话
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-[13px] text-muted-foreground">
            <AnchorIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{anchorName}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground/60">无会话</span>
          </span>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              title="新建会话"
              disabled={!projectReady}
            >
              <Plus className="!size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="max-w-52 truncate">
              {anchor ? `挂在 ${anchorName}` : '项目根（无聚焦兜底）'}
            </DropdownMenuLabel>
            {agents.map((a) => (
              <DropdownMenuItem key={a.id} onClick={() => void openSession(anchor, a.id)}>
                用 {a.label} 打开
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1">
        {shownSession ? (
          <TerminalView key={shownSession.id} sessionId={shownSession.id} />
        ) : projectReady ? (
          /* Full-page launch pad (F-1) — spawn only on explicit click. */
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <SquareTerminal className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="max-w-64 truncate text-sm">
                {anchor ? (
                  <>
                    挂在 <span className="font-semibold">{anchorName}</span> 的新会话
                  </>
                ) : (
                  <span className="font-semibold">项目根会话</span>
                )}
              </p>
              <p className="mt-1 max-w-64 text-xs text-muted-foreground">
                {anchor
                  ? '终端将注入 FOCUS_DOC 指向这篇文档'
                  : '不注入 FOCUS_DOC —— 无聚焦的兜底会话'}
              </p>
            </div>
            <div className="flex w-64 flex-col gap-2">
              {agents.map((a) => (
                <Button
                  key={a.id}
                  variant="secondary"
                  className="h-9 justify-start gap-2 px-4"
                  onClick={() => void openSession(anchor, a.id)}
                >
                  <SquareTerminal className="!size-4 text-muted-foreground" />
                  用 {a.label} 打开
                </Button>
              ))}
            </div>
            <p className="max-w-64 text-xs text-muted-foreground/70">
              会话锚定一经创建终生不变；同一文档可同时挂多个会话。
            </p>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
            <p>没有会话。</p>
            <p className="max-w-56 text-xs text-muted-foreground/70">先打开一个项目。</p>
          </div>
        )}
      </div>
    </div>
  );
}
