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
 * Imperative calls share one FIFO queue. A later request never settles or
 * overwrites the user's earlier decision.
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
import { translate } from '@renderer/i18n';

interface ConfirmRequest {
  kind: 'confirm';
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  tone: 'default' | 'destructive';
  resolve: (ok: boolean) => void;
}

type ActionDialogResult = 'primary' | 'secondary' | 'cancel';

interface ActionRequest {
  kind: 'action';
  title: string;
  message: string;
  primaryText: string;
  secondaryText?: string;
  cancelText: string;
  tone: 'default' | 'destructive';
  resolve: (result: ActionDialogResult) => void;
}

interface AlertRequest {
  kind: 'alert';
  title: string;
  message: string;
  buttonText: string;
  tone: 'default' | 'destructive';
  resolve: () => void;
}

type DialogRequest = ConfirmRequest | AlertRequest | ActionRequest;

let queue: DialogRequest[] = [];
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
  return new Promise<boolean>((resolve) => {
    queue = [...queue, {
      kind: 'confirm',
      title: opts.title,
      message: opts.message,
      confirmText: opts.confirmText ?? translate('dialog.defaultConfirm'),
      cancelText: opts.cancelText ?? translate('dialog.defaultCancel'),
      tone: opts.tone ?? 'default',
      resolve,
    }];
    emit();
  });
}

function currentRequest(): DialogRequest | null {
  return queue[0] ?? null;
}

function useCurrent<TKind extends DialogRequest['kind']>(
  kind: TKind,
): Extract<DialogRequest, { kind: TKind }> | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => {
      const current = currentRequest();
      return current?.kind === kind
        ? current as Extract<DialogRequest, { kind: TKind }>
        : null;
    },
  );
}

// ── Alert dialog (single "OK" button, for errors / notices) ─────────────

export interface AlertOptions {
  title: string;
  message: string;
  buttonText?: string;
  tone?: 'default' | 'destructive';
}

export function alertDialog(opts: AlertOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    queue = [...queue, {
      kind: 'alert',
      title: opts.title,
      message: opts.message,
      buttonText: opts.buttonText ?? translate('dialog.defaultOk'),
      tone: opts.tone ?? 'destructive',
      resolve,
    }];
    emit();
  });
}

export interface ActionDialogOptions {
  title: string;
  message: string;
  primaryText: string;
  secondaryText?: string;
  cancelText?: string;
  tone?: 'default' | 'destructive';
}

export function actionDialog(opts: ActionDialogOptions): Promise<ActionDialogResult> {
  return new Promise<ActionDialogResult>((resolve) => {
    queue = [...queue, {
      kind: 'action',
      title: opts.title,
      message: opts.message,
      primaryText: opts.primaryText,
      cancelText: opts.cancelText ?? translate('dialog.defaultCancel'),
      tone: opts.tone ?? 'default',
      resolve,
      ...(opts.secondaryText !== undefined ? { secondaryText: opts.secondaryText } : {}),
    }];
    emit();
  });
}

function removeCurrent(req: DialogRequest): void {
  if (queue[0] !== req) return;
  queue = queue.slice(1);
  emit();
}

export function AlertDialog(): JSX.Element | null {
  const req = useCurrent('alert');
  if (!req) return null;

  const settle = (): void => {
    const resolve = req.resolve;
    removeCurrent(req);
    resolve();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && settle()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{req.title}</DialogTitle>
        </DialogHeader>
        <p className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {req.message}
        </p>
        <DialogFooter>
          <Button
            variant={req.tone === 'destructive' ? 'destructive' : 'default'}
            onClick={() => settle()}
          >
            {req.buttonText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog(): JSX.Element | null {
  const req = useCurrent('confirm');
  if (!req) return null;

  // Clear state BEFORE resolving so the awaiter's continuation (which may
  // focus the terminal) runs after the dialog has begun unmounting.
  const settle = (ok: boolean): void => {
    const resolve = req.resolve;
    removeCurrent(req);
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

export function ActionDialog(): JSX.Element | null {
  const req = useCurrent('action');
  if (!req) return null;

  const settle = (result: ActionDialogResult): void => {
    const resolve = req.resolve;
    removeCurrent(req);
    resolve(result);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && settle('cancel')}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{req.title}</DialogTitle>
        </DialogHeader>
        <p className="max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {req.message}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => settle('cancel')}>
            {req.cancelText}
          </Button>
          {req.secondaryText && (
            <Button variant="outline" onClick={() => settle('secondary')}>
              {req.secondaryText}
            </Button>
          )}
          <Button
            variant={req.tone === 'destructive' ? 'destructive' : 'default'}
            onClick={() => settle('primary')}
          >
            {req.primaryText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
