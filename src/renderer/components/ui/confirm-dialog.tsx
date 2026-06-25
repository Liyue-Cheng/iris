/**
 * Promise-based in-app confirm — the replacement for native `window.confirm`.
 *
 * Native `alert`/`confirm`/`prompt` block the renderer's event loop, and on
 * Windows Electron the IME (IMM32/TSF) input context is frequently NOT handed
 * back to the originating element after the modal closes — the whole window's
 * IME wedges (issue 2026-06-25 软件焦点问题, 缺陷 C). This routes every
 * confirmation through a Radix Dialog instead: in-DOM React, no native modal,
 * no IME-context damage.
 *
 * Imperative `confirmDialog(opts)` returns a Promise<boolean>; mount one
 * `<ConfirmDialog />` near the app root (App.tsx). Module-level singleton, so
 * any caller anywhere awaits the same dialog — at most one open at a time.
 */
import { useSyncExternalStore } from 'react';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

interface ConfirmRequest {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  tone: 'default' | 'destructive';
  resolve: (ok: boolean) => void;
}

let current: ConfirmRequest | null = null;
const subs = new Set<() => void>();

function emit(): void {
  subs.forEach((cb) => cb());
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'default' | 'destructive';
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  // Defensive: a still-open request is superseded → resolve it as cancelled
  // so its awaiter never hangs. Callers (paste path) await sequentially, so
  // this normally never fires.
  if (current) {
    const prev = current;
    current = null;
    prev.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    current = {
      title: opts.title,
      message: opts.message,
      confirmText: opts.confirmText ?? '继续',
      cancelText: opts.cancelText ?? '取消',
      tone: opts.tone ?? 'default',
      resolve,
    };
    emit();
  });
}

function useCurrent(): ConfirmRequest | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => current,
  );
}

export function ConfirmDialog(): JSX.Element | null {
  const req = useCurrent();
  if (!req) return null;

  // Clear state BEFORE resolving so the awaiter's continuation (which may
  // focus the terminal) runs after the dialog has begun unmounting.
  const settle = (ok: boolean): void => {
    const resolve = req.resolve;
    current = null;
    emit();
    resolve(ok);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && settle(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{req.title}</DialogTitle>
        </DialogHeader>
        <p className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {req.message}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => settle(false)}>
            {req.cancelText}
          </Button>
          <Button
            variant={req.tone === 'destructive' ? 'destructive' : 'default'}
            onClick={() => settle(true)}
          >
            {req.confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
