import type { ComponentPropsWithoutRef, MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openExternalUrl } from '@renderer/lib/shell-actions';

function ReplyLink({ href, children }: ComponentPropsWithoutRef<'a'>): JSX.Element {
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (href) void openExternalUrl(href).catch(() => undefined);
  };
  return (
    <a href={href} onClick={open} onAuxClick={(event) => { if (event.button === 1) open(event); }}>
      {children}
    </a>
  );
}

/** Links in replies must never navigate the document that owns our IPC bridge. */
export function AgentReplyMarkdown({ content }: { content: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{ a: ReplyLink }}
    >
      {content}
    </ReactMarkdown>
  );
}
