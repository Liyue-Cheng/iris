/**
 * Raw file tree — the escape hatch (软件定义书 §5: 裸文件树是 toggle 出的
 * 逃生舱). Shows .iris/ exactly as it sits on disk, non-md files included.
 * Markdown files are clickable into the preview; everything else is inert.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, File, Folder } from 'lucide-react';
import type { RawTreeNode } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { projectStore, useProject } from '@renderer/stores/project-store';

function Node({ node, depth }: { node: RawTreeNode; depth: number }): JSX.Element {
  const [open, setOpen] = useState(depth < 2);
  const { selectedPath } = useProject();

  if (node.kind === 'dir') {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-1 rounded-sm px-2 py-0.5 text-[13px] hover:bg-muted"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <Folder className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} />)}
      </div>
    );
  }

  const isMd = node.name.toLowerCase().endsWith('.md');
  const selected = selectedPath === node.path;
  return (
    <button
      type="button"
      disabled={!isMd}
      onClick={() => void projectStore.selectDoc(node.path)}
      className={cn(
        'flex w-full items-center gap-1 rounded-sm px-2 py-0.5 text-left text-[13px]',
        isMd ? (selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted') : 'cursor-default text-muted-foreground/60',
      )}
      style={{ paddingLeft: `${depth * 12 + 8 + 16}px` }}
      title={node.path}
    >
      {isMd ? (
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      )}
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function RawTree({ root }: { root: RawTreeNode }): JSX.Element {
  return (
    <div className="py-1">
      <Node node={root} depth={0} />
    </div>
  );
}
