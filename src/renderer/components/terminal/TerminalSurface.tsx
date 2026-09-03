import type { DragEventHandler, MouseEvent, RefObject, WheelEventHandler } from 'react';

/** Shared xterm host surface. Domain components own transport and controls. */
export function TerminalSurface({
  hostRef,
  revealed,
  onContextMenu,
  onWheel,
  onDragOver,
  onDrop,
}: {
  hostRef: RefObject<HTMLDivElement>;
  revealed: boolean;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  onWheel?: WheelEventHandler<HTMLDivElement>;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
}): JSX.Element {
  return (
    <div
      ref={hostRef}
      className="h-full w-full px-1 pt-1"
      style={revealed ? undefined : { opacity: 0 }}
      onContextMenu={onContextMenu}
      onWheel={onWheel}
      onDragOver={onDragOver}
      onDrop={onDrop}
    />
  );
}
