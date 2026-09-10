/**
 * Shared shell for the Agent "watch one long-running thing" dialogs: terminal
 * output and background task logs. They differ only in the header subtitle and
 * the body, so the icon, title, status badge, action slot, and frame live here
 * once — a task dialog must not drift into looking like a different feature.
 */
import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { statusBadgeClass, type AgentStatusTone } from '@renderer/lib/agent-status';

export function AgentWorkbenchDialog({
  icon,
  title,
  titleLabel,
  monoTitle,
  badge,
  subtitle,
  subtitleLabel,
  actions,
  children,
  bodyClassName,
  onClose,
}: {
  icon: ReactNode;
  title: string;
  titleLabel: string;
  monoTitle?: boolean;
  badge?: ReactNode;
  subtitle?: ReactNode;
  subtitleLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(760px,78vh)] w-[min(1100px,92vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:rounded-xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b bg-card/70 px-4 py-2.5 pr-12">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
            aria-hidden="true"
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <DialogTitle
                className={`min-w-0 truncate text-[13px] font-medium leading-5${monoTitle ? ' font-mono' : ''}`}
                aria-label={titleLabel}
              >
                {title}
              </DialogTitle>
              {badge}
            </div>
            {subtitle !== undefined && (
              <div
                className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
                aria-label={subtitleLabel}
              >
                {subtitle}
              </div>
            )}
          </div>
          {actions}
        </header>
        <div className={bodyClassName ?? 'relative min-h-0 flex-1'}>{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Status pill for both dialogs. The running tone carries the live dot, so
 * "still working" reads the same everywhere it appears.
 */
export function AgentStatusBadge({
  tone,
  label,
}: {
  tone: AgentStatusTone;
  label: string;
}): JSX.Element {
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusBadgeClass(tone)}`}
    >
      {tone === 'running' && (
        <span
          className="iris-agent-terminal-dot h-1.5 w-1.5 rounded-full bg-emerald-500"
          data-running="true"
          aria-hidden="true"
        />
      )}
      {label}
    </span>
  );
}
