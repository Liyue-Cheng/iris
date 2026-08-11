import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';

export function TerminalContextMenu(props: {
  children: ReactNode;
  hasSelection: boolean;
  onOpenChange: (open: boolean) => void;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onSearch: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <ContextMenu onOpenChange={props.onOpenChange}>
      <ContextMenuTrigger asChild>{props.children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!props.hasSelection} onClick={props.onCopy}>
          {t('terminal.copy')}
        </ContextMenuItem>
        <ContextMenuItem onClick={props.onPaste}>{t('terminal.paste')}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={props.onClear}>{t('terminal.clear')}</ContextMenuItem>
        <ContextMenuItem onClick={props.onSearch}>{t('terminal.search')}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
