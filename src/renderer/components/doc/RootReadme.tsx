/**
 * The special root node's middle view (E-4 左栏根节点特殊化): the project
 * README rendered read-only (or a "暂无 README" placeholder). READ-ONLY by
 * design — the README is the user's project file, not an Iris doc; editing
 * it would drag a non-.iris file through the zero-diff editor discipline
 * for no gain. Source of truth stays on disk; reloads on every selection.
 */
import { useEffect, useRef, useState } from 'react';
import { BookOpen, FolderRoot, Loader2 } from 'lucide-react';
import { Crepe } from '@milkdown/crepe';
import { CHANNELS } from '@shared/protocol';
import type { DocContent } from '@shared/types';
import { useProject } from '@renderer/stores/project-store';

function ReadonlyCrepe({ content }: { content: string }): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const crepe = new Crepe({
      root: el,
      defaultValue: content,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.Latex]: false,
        [Crepe.Feature.BlockEdit]: false,
      },
    });
    crepe.setReadonly(true);
    void crepe.create();
    return () => {
      void crepe.destroy();
    };
  }, [content]);

  return <div ref={rootRef} className="crepe-host h-full overflow-y-auto" />;
}

export function RootReadme(): JSX.Element {
  const { scan } = useProject();
  const [state, setState] = useState<{ loading: boolean; content: string | null }>({
    loading: true,
    content: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, content: null });
    window.api
      .invoke<{ path: string }, DocContent>(CHANNELS.DOC_READ, { path: 'README.md' })
      .then((doc) => {
        if (!cancelled) setState({ loading: false, content: doc.raw });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, content: null });
      });
    return () => {
      cancelled = true;
    };
  }, [scan?.projectRoot, scan?.scannedAt]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/30 px-4">
        <FolderRoot className="h-4 w-4 text-muted-foreground" />
        <span className="text-base font-semibold">{scan?.projectName ?? '项目根'}</span>
        <span className="truncate text-xs text-muted-foreground/70">README.md（只读）</span>
      </div>
      <div className="min-h-0 flex-1">
        {state.loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : state.content !== null ? (
          <ReadonlyCrepe content={state.content} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <BookOpen className="h-8 w-8 opacity-40" />
            <p className="text-sm">暂无 README</p>
            <p className="text-xs text-muted-foreground/70">
              项目根没有 README.md —— 在项目里创建一个即可在这里展示。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
