/**
 * Protocol-init confirmation. Touching the project root (AGENTS.md) is the
 * one sanctioned exception to 尊重边界 — hence an explicit dialog spelling
 * out every action before the verb fires. The scaffold itself is idempotent
 * (missing pieces only), so this same dialog also serves as "repair".
 */
import { useState } from 'react';
import type { ProjectInitResult } from '@shared/types';
import { pipeline } from '@renderer/cpu';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

export function InitDialog({
  open,
  onClose,
  missingConstitutionOnly,
}: {
  open: boolean;
  onClose: () => void;
  /** True when .iris/ exists but the constitution is missing (repair mode). */
  missingConstitutionOnly: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ProjectInitResult | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = (await pipeline.dispatch('project.init', {})) as ProjectInitResult;
      setDone(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    setDone(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{missingConstitutionOnly ? '补全 Iris 协议' : '初始化 Iris 协议'}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-left">
              <p>将在当前项目执行（已存在的部分自动跳过）：</p>
              <ul className="list-disc space-y-1 pl-5 text-xs">
                <li>
                  创建 <code>.iris/</code> 下的四个类型文件夹（status / issue / report / misc）
                </li>
                <li>
                  写入 <code>.iris/CONVENTIONS.md</code> 宪法模板（写入后归你所有，应用只读不改）
                </li>
                <li>
                  在项目根 <code>AGENTS.md</code> 追加 Iris 引导段（无则创建；带标记，重复运行不重复追加）
                  —— 这是唯一一次触碰项目根
                </li>
              </ul>
              <p className="text-xs text-muted-foreground">
                删掉 .iris/ 与该引导段即完全卸载，项目毫发无伤。
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        {done && (
          <div className="rounded-md bg-muted/60 p-3 text-xs">
            <p className="font-medium text-[var(--rp-pine)]">完成</p>
            <p>
              新建文件夹：{done.createdFolders.length > 0 ? done.createdFolders.join('、') : '无（已齐）'}
            </p>
            <p>
              宪法：{done.constitution === 'created' ? '已写入模板' : '已存在，未动'}；AGENTS.md：
              {done.agentsMd === 'created'
                ? '已创建'
                : done.agentsMd === 'appended'
                  ? '已追加引导段'
                  : '已有引导段，未动'}
            </p>
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          {done ? (
            <Button onClick={close}>好</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                取消
              </Button>
              <Button onClick={() => void run()} disabled={busy}>
                {busy ? '执行中…' : '确认执行'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
