import type { ReactNode, RefObject } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface TerminalSearchBarProps {
  inputRef: RefObject<HTMLInputElement>;
  text: string;
  caseSensitive: boolean;
  results: { matches: number; current: number };
  onTextChange: (text: string) => void;
  onCaseSensitiveChange: (value: boolean) => void;
  onSearch: (direction: 'next' | 'previous') => void;
  onClose: () => void;
}

export function TerminalSearchBar(props: TerminalSearchBarProps): JSX.Element {
  const { t } = useTranslation();
  const disabled = !props.text || props.results.matches === 0;
  return (
    <div
      role="search"
      aria-label={t('terminal.searchAria')}
      className="absolute right-4 top-2 z-50 flex items-center gap-1 rounded-md border bg-popover px-1.5 py-1 text-popover-foreground shadow-md"
    >
      <input
        ref={props.inputRef}
        type="text"
        className="h-6 w-56 rounded-sm border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
        placeholder={t('terminal.searchPlaceholder')}
        value={props.text}
        onChange={(event) => props.onTextChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            props.onSearch(event.shiftKey ? 'previous' : 'next');
          }
        }}
      />
      <span className="min-w-[3rem] px-1 text-center font-mono text-[11px] text-muted-foreground">
        {props.text
          ? props.results.matches > 0
            ? `${props.results.current}/${props.results.matches}`
            : t('common.noMatches')
          : '-'}
      </span>
      <IconButton
        title={t('terminal.previous')}
        ariaLabel={t('terminal.previousAria')}
        disabled={disabled}
        onClick={() => props.onSearch('previous')}
      >
        <ChevronUp className="size-3.5" />
      </IconButton>
      <IconButton
        title={t('terminal.next')}
        ariaLabel={t('terminal.nextAria')}
        disabled={disabled}
        onClick={() => props.onSearch('next')}
      >
        <ChevronDown className="size-3.5" />
      </IconButton>
      <IconButton
        title={t('terminal.matchCase')}
        ariaLabel={t('terminal.matchCase')}
        pressed={props.caseSensitive}
        onClick={() => props.onCaseSensitiveChange(!props.caseSensitive)}
      >
        <CaseSensitive className="size-3.5" />
      </IconButton>
      <IconButton
        title={t('terminal.closeSearch')}
        ariaLabel={t('terminal.closeSearchAria')}
        destructive
        onClick={props.onClose}
      >
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}

function IconButton(props: {
  title: string;
  ariaLabel: string;
  disabled?: boolean;
  pressed?: boolean;
  destructive?: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`flex h-6 w-6 items-center justify-center rounded-sm border hover:bg-accent disabled:opacity-40 ${
        props.pressed ? 'bg-accent text-accent-foreground' : ''
      } ${props.destructive ? 'hover:bg-destructive hover:text-destructive-foreground' : ''}`}
      onClick={props.onClick}
      title={props.title}
      aria-label={props.ariaLabel}
      aria-pressed={props.pressed}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
}
