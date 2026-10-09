'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../button/button';
import { useAppText } from './app-labels';
import { ConversationList } from '../pi-chat/pi-chat';
import type { ConversationsConfig } from '../pi-chat/pi-chat';
import { cn } from '../utils/utils';

/**
 * The sessions pane: a title with New, then the searchable conversation list of `pi-chat` (`ConversationList`: search, Archived filter,
 * rename, archive, delete). Docked at the left on a wide screen; a drawer over the page with a backdrop on a narrow one, closed by
 * Escape, the backdrop, the close button or choosing a conversation. With `library`, tabs at the top switch the pane between the
 * conversations and the host's library (for example a `FileTree`).
 */
export type SessionsView = 'conversations' | 'library';

export function SessionsPane({ conversations, title: givenTitle, drawer, onClose, footer, library, view = 'conversations', onViewChange }: {
  readonly conversations: ConversationsConfig;
  /** A second view of the pane; invoke onPicked after opening an item to close a mobile drawer. */
  readonly library?: ((onPicked: () => void) => ReactNode) | undefined;
  /** Which view is shown when there is a library. */
  readonly view?: SessionsView | undefined;
  readonly onViewChange?: ((view: SessionsView) => void) | undefined;
  /** Host content below the list; invoke onPicked after choosing a library item to close a mobile drawer. */
  readonly footer?: ((onPicked: () => void) => ReactNode) | undefined;
  readonly title?: string;
  /** Rendered as a drawer (narrow screens). */
  readonly drawer: boolean;
  /** Closes the drawer; absent when docked. */
  readonly onClose?: (() => void) | undefined;
}) {
  const { labels, icons } = useAppText();
  const title = givenTitle ?? labels.sessionsTitle;
  useEffect(() => {
    if (!drawer || !onClose) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [drawer, onClose]);
  const picked = drawer ? onClose : undefined;
  const shown: SessionsView = library ? view : 'conversations';
  return <>
    {drawer && <button type="button" tabIndex={-1} aria-hidden="true" data-testid="sessions-backdrop" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-black/40" />}
    <aside data-testid="conversations" data-drawer={drawer ? 'true' : 'false'} aria-label={title} {...(drawer ? { role: 'dialog', 'aria-modal': true } : {})}
      className={cn('pi-chat flex min-h-0 flex-col bg-background text-foreground', drawer
        ? 'fixed inset-y-0 left-0 z-50 w-[min(20rem,85vw)] border-r border-border shadow-xl pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
        : 'w-72 shrink-0 border-r border-border')}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {library
          ? <div role="tablist" aria-label={title} className="flex min-w-0 flex-1 items-center gap-1">
              {(['conversations', 'library'] as const).map(tab => {
                const Icon = tab === 'library' ? icons.library : icons.sessions;
                return <button key={tab} type="button" role="tab" data-testid={`sessions-tab-${tab}`} aria-selected={shown === tab} onClick={() => onViewChange?.(tab)}
                  className={cn('inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm font-medium', shown === tab ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{tab === 'library' ? labels.library : title}</span>
                </button>;
              })}
            </div>
          : <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{title}</h2>}
        {conversations.onNew && shown === 'conversations' && <Button size="sm" variant="outline" data-testid="conversation-new" onClick={() => { conversations.onNew!(); picked?.(); }}><icons.newChat className="size-3.5" aria-hidden="true" />{labels.newChat}</Button>}
        {drawer && onClose && <Button size="icon-sm" variant="ghost" aria-label={labels.closeSessions} title={labels.close} data-testid="sessions-close" onClick={onClose}><icons.closeSessions className="size-4" aria-hidden="true" /></Button>}
      </header>
      {shown === 'library' && library
        ? <div role="tabpanel" data-testid="sessions-library" className="flex min-h-0 flex-1 flex-col">{library(() => picked?.())}</div>
        : <ConversationList conversations={conversations} onPicked={picked} />}
      {footer && <div className="shrink-0 border-t border-border">{footer(() => picked?.())}</div>}
    </aside>
  </>;
}

/** The chat header's button that shows or hides the sessions pane (opens the drawer on a narrow screen). */
export function SessionsToggle({ open, drawer, onToggle }: { readonly open: boolean; readonly drawer: boolean; readonly onToggle: () => void }) {
  const { labels, icons } = useAppText();
  const label = drawer ? labels.openSessions : open ? labels.hideSessions : labels.showSessions;
  return <Button size="icon-sm" variant="ghost" data-testid="sessions-toggle" aria-label={label} title={label} aria-expanded={open} onClick={onToggle} className="-ml-1 shrink-0 text-muted-foreground">
    <icons.sessionsToggle className="size-4" aria-hidden="true" />
  </Button>;
}
