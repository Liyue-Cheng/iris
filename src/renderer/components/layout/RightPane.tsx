/**
 * Right pane — the session panel (软件定义书 §5 右栏): vertical session
 * list + the active session's terminal. Sessions anchor to docs; the
 * project-root session is the unfocused fallback, opened from the +
 * menu here. Detach, not dispatch: sessions stay interactive, the user
 * walks away and comes back.
 */
import { Plus, X, FileText, FolderRoot } from 'lucide-react';
import type { SessionInfo } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { useSessions, sessionStore } from '@renderer/stores/session-store';
import { useSettings } from '@renderer/stores/settings-store';
import { useProject } from '@renderer/stores/project-store';
import { closeSession, openSession } from '@renderer/lib/session-actions';
import { TerminalView } from '@renderer/components/terminal/TerminalView';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';

const STATE_DOT: Record<SessionInfo['state'], { glyph: string; cls: string; label: string }> = {
  active: { glyph: '●', cls: 'text-[var(--rp-foam)]', label: '工作中' },
  idle: { glyph: '◐', cls: 'text-[var(--rp-gold)]', label: '空闲/等输入' },
  exited: { glyph: '○', cls: 'text-muted-foreground/60', label: '已退出' },
};

function anchorLabel(s: SessionInfo): string {
  if (!s.docPath) return '项目根';
  return s.docPath.split('/').pop()?.replace(/\.md$/i, '') ?? s.docPath;
}

function SessionRow({ session }: { session: SessionInfo }): JSX.Element {
  const { activeSessionId } = useSessions();
  const dot = STATE_DOT[session.state];
  const selected = session.id === activeSessionId;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => sessionStore.select(session.id)}
      onKeyDown={(e) => e.key === 'Enter' && sessionStore.select(session.id)}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-1.5 border-b border-border/40 px-2 py-1.5 text-left text-xs',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
      )}
      title={session.docPath ?? session.projectRoot}
    >
      <span className={cn('shrink-0 text-[10px]', dot.cls)} title={dot.label}>
        {dot.glyph}
      </span>
      <span className="shrink-0 font-medium">{session.displayName}</span>
      <span className="flex min-w-0 items-center gap-0.5 text-muted-foreground">
        {session.docPath ? (
          <FileText className="h-3 w-3 shrink-0" />
        ) : (
          <FolderRoot className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{anchorLabel(session)}</span>
      </span>
      {session.state === 'exited' && (
        <span className="shrink-0 text-[10px] text-muted-foreground/60">
          exit {session.exitCode}
        </span>
      )}
      <button
        type="button"
        title="关闭会话"
        onClick={(e) => {
          e.stopPropagation();
          void closeSession(session.id);
        }}
        className="ml-auto shrink-0 rounded-sm p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function RightPane(): JSX.Element {
  const { sessions, activeSessionId } = useSessions();
  const settings = useSettings();
  const { phase, selectedPath } = useProject();
  const agents = settings?.agents ?? [];
  const projectReady = phase === 'ready';

  return (
    <div className="flex h-full flex-col bg-card/50">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <span className="text-xs font-medium text-muted-foreground">会话</span>
        <span className="text-[10px] text-muted-foreground/60">{sessions.length}</span>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" disabled={!projectReady}>
                <Plus className="!size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {selectedPath && (
                <>
                  <DropdownMenuLabel className="max-w-52 truncate">
                    挂在 {selectedPath.split('/').pop()}
                  </DropdownMenuLabel>
                  {agents.map((a) => (
                    <DropdownMenuItem
                      key={`doc-${a.id}`}
                      onClick={() => void openSession(selectedPath, a.id)}
                    >
                      用 {a.label} 打开
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              <DropdownMenuLabel>项目根（无聚焦兜底）</DropdownMenuLabel>
              {agents.map((a) => (
                <DropdownMenuItem key={`root-${a.id}`} onClick={() => void openSession(null, a.id)}>
                  {a.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {sessions.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-y-auto border-b">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {activeSessionId ? (
          <TerminalView key={activeSessionId} sessionId={activeSessionId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
            <p>没有会话。</p>
            <p className="max-w-52 text-muted-foreground/70">
              在左栏右键一篇文档「用 X 打开」，或点上方 + 开一个项目根会话。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
