'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';
import type { ChatHistoryState } from '@boring/ui/native-chat';
import { ArchiveIcon, ArchiveRestoreIcon, ArrowLeftIcon, CheckIcon, HistoryIcon, MessageSquareIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from 'lucide-react';
import { Button } from '../button/button';
import type { ConversationItem, ConversationsConfig } from './config';
import { Markdown } from './markdown';
import { cn } from '../utils/utils';
import { isFileBlock } from './rows';

const DAY = 86_400_000;
const toMs = (value: ConversationItem['updatedAt']): number | undefined => {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/** Short relative time for a list row: "now", "5m", "3h", "Yesterday", "4d", then a date. */
export function relativeTime(value: ConversationItem['updatedAt'], now = Date.now()): string {
  const ms = toMs(value);
  if (ms === undefined) return '';
  const age = Math.max(0, now - ms);
  if (age < 60_000) return 'now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < DAY) return `${Math.floor(age / 3_600_000)}h`;
  const days = Math.floor(age / DAY);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(days > 300 ? { year: 'numeric' } : {}) });
}

function groupOf(value: ConversationItem['updatedAt'], now: number): string {
  const ms = toMs(value);
  if (ms === undefined) return 'Conversations';
  const age = now - ms;
  return age < DAY ? 'Today' : age < 2 * DAY ? 'Yesterday' : age < 7 * DAY ? 'Previous 7 days' : 'Older';
}
const ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Older', 'Conversations'];

/**
 * The searchable list of past conversations: a search box (server-side when the host offers `search`), the Archived filter, rows grouped by
 * recency with the open one marked, and the row actions the host offers (rename, archive, delete). It fills its container; `ConversationHistory`
 * puts it in a popover or sheet, the `pi-app` block in its sessions pane. `onPicked` runs after a row is chosen.
 */
export function ConversationList({ conversations, onPicked, autoFocus = false }: {
  readonly conversations: ConversationsConfig;
  readonly onPicked?: (() => void) | undefined;
  /** Focus the search box on mount (not on touch screens). */
  readonly autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  // Server-side results while a query is typed or the Archived filter is on (when the host offers `search`).
  const [found, setFound] = useState<{ readonly items: readonly ConversationItem[]; readonly loading: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const now = useMemo(() => Date.now(), [conversations.items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoFocus && !globalThis.matchMedia?.('(pointer: coarse)').matches) search.current?.focus(); }, [autoFocus]);
  const serverSearch = conversations.search;
  useEffect(() => {
    const needle = query.trim();
    if (!serverSearch || (!needle && !archived)) { setFound(null); return; }
    const controller = new AbortController();
    setFound(previous => ({ items: previous?.items ?? [], loading: true }));
    const timer = setTimeout(() => {
      serverSearch(needle, { archived }, controller.signal).then(items => { if (!controller.signal.aborted) setFound({ items, loading: false }); })
        .catch(() => { if (!controller.signal.aborted) setFound({ items: [], loading: false }); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [serverSearch, query, archived, revision]);
  /** Runs one row action; the host refreshes `items`, and a server-side search runs again. */
  const run = (action: () => Promise<void>) => {
    setFailure(null);
    action().then(() => setRevision(value => value + 1), () => setFailure('That did not work. Try again.'));
  };
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const items = found ? found.items : conversations.items.filter(item => !item.archived && (!needle || (item.title ?? 'New conversation').toLowerCase().includes(needle)));
    const sorted = [...items].sort((a, b) => (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0));
    const groups = new Map<string, ConversationItem[]>();
    for (const item of sorted) { const key = groupOf(item.updatedAt, now); groups.set(key, [...(groups.get(key) ?? []), item]); }
    return ORDER.flatMap(key => groups.has(key) ? [{ key, items: groups.get(key)! }] : []);
  }, [conversations.items, found, query, now]);
  const loading = found ? found.loading : conversations.loading;
  const action = 'text-muted-foreground';
  const total = shown.reduce((sum, group) => sum + group.items.length, 0);
  return <>
      <div className="relative flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-5.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input ref={search} type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="Search conversations" aria-label="Search conversations" data-testid="conversation-search"
          className="h-9 w-full rounded-lg border border-border bg-background pr-3 pl-8 text-base outline-none max-sm:h-11 pointer-coarse:h-11 placeholder:text-muted-foreground focus-visible:border-ring/60 focus-visible:ring-[3px] focus-visible:ring-ring/15 sm:text-sm" />
        {conversations.archive && serverSearch && <Button size="sm" variant={archived ? 'secondary' : 'ghost'} aria-pressed={archived} data-testid="conversations-archived" className="shrink-0 text-muted-foreground"
          onClick={() => setArchived(value => !value)}><ArchiveIcon className="size-3.5" aria-hidden="true" />Archived</Button>}
      </div>
      {failure && <p role="alert" className="m-0 shrink-0 px-3 pt-2 text-xs text-destructive">{failure}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5" aria-busy={loading ? 'true' : undefined}>
        {total === 0 && <p role="status" data-testid="conversations-empty" className="m-0 px-3 py-8 text-center text-sm text-muted-foreground">
          {loading ? 'Loading conversations…' : query.trim() ? `No conversation matches “${query.trim()}”.` : archived ? 'No archived conversations.' : 'No conversations yet.'}</p>}
        {shown.map(group => <section key={group.key} aria-label={group.key} className="mb-1">
          <h4 className="m-0 px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground">{group.key}</h4>
          <ul className="m-0 list-none p-0">
            {group.items.map(item => {
              const active = item.id === conversations.activeId;
              const title = item.title?.trim() || 'New conversation';
              if (renaming === item.id && conversations.rename) {
                const rename = conversations.rename;
                return <li key={item.id}>
                  <form className="flex min-h-10 items-center gap-2 px-2.5 py-1" onSubmit={event => {
                    event.preventDefault();
                    const value = new FormData(event.currentTarget).get('title')?.toString().trim();
                    setRenaming(null);
                    if (value && value !== item.title) run(() => rename(item.id, value));
                  }}>
                    <PencilIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <input name="title" autoFocus defaultValue={title} maxLength={200} aria-label="Conversation name" data-testid="conversation-rename-input"
                      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null); } }}
                      className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-base outline-none focus-visible:border-ring/60 focus-visible:ring-[3px] focus-visible:ring-ring/15 sm:text-sm" />
                    <Button type="submit" size="sm" variant="outline" data-testid="conversation-rename-save">Save</Button>
                  </form>
                </li>;
              }
              return <li key={item.id} className="group/row relative flex items-center">
                <button type="button" data-testid="conversation-row" data-conversation-id={item.id} data-active={active ? 'true' : undefined} aria-current={active ? 'true' : undefined}
                  title={item.lastMessage ?? undefined}
                  onClick={() => { if (!active) conversations.onSelect(item.id); onPicked?.(); }}
                  className={cn('flex min-h-10 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 max-sm:min-h-12 motion-reduce:transition-none',
                    active ? 'bg-muted font-medium' : 'hover:bg-muted/60')}>
                  <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  {active ? <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><CheckIcon className="size-3.5" aria-hidden="true" />Current</span>
                    : <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{relativeTime(item.updatedAt, now)}</span>}
                </button>
                {(conversations.rename || conversations.archive || conversations.remove) && <div data-testid="conversation-actions"
                  className={cn('flex shrink-0 items-center gap-0.5 pr-1 pointer-fine:absolute pointer-fine:right-1 pointer-fine:rounded-md pointer-fine:bg-background pointer-fine:shadow-sm',
                    confirming === item.id ? '' : 'pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100')}>
                  {confirming === item.id && conversations.remove ? <>
                    <Button size="sm" variant="destructive" data-testid="conversation-delete-confirm" onClick={() => { const remove = conversations.remove!; setConfirming(null); run(() => remove(item.id)); }}>Delete</Button>
                    <Button size="icon-sm" variant="ghost" aria-label="Keep conversation" className={action} onClick={() => setConfirming(null)}><XIcon className="size-3.5" aria-hidden="true" /></Button>
                  </> : <>
                    {conversations.rename && <Button size="icon-sm" variant="ghost" aria-label={`Rename ${title}`} title="Rename" data-testid="conversation-rename" className={action} onClick={() => setRenaming(item.id)}><PencilIcon className="size-3.5" aria-hidden="true" /></Button>}
                    {conversations.archive && <Button size="icon-sm" variant="ghost" aria-label={`${item.archived ? 'Restore' : 'Archive'} ${title}`} title={item.archived ? 'Restore' : 'Archive'} data-testid="conversation-archive" className={action}
                      onClick={() => { const archive = conversations.archive!; run(() => archive(item.id, !item.archived)); }}>{item.archived ? <ArchiveRestoreIcon className="size-3.5" aria-hidden="true" /> : <ArchiveIcon className="size-3.5" aria-hidden="true" />}</Button>}
                    {conversations.remove && <Button size="icon-sm" variant="ghost" aria-label={`Delete ${title}`} title="Delete" data-testid="conversation-delete" className={action} onClick={() => setConfirming(item.id)}><Trash2Icon className="size-3.5" aria-hidden="true" /></Button>}
                  </>}
                </div>}
              </li>;
            })}
          </ul>
        </section>)}
      </div>
  </>;
}

/**
 * The list of past conversations in a dialog: a header with New, then `ConversationList`.
 * An anchored card on a wide screen and a full-screen sheet on a phone. Escape or a click outside closes it.
 */
export function ConversationHistory({ conversations, onClose, onBrowseEarlier, placement = 'below' }: {
  readonly conversations: ConversationsConfig;
  readonly onClose: () => void;
  /** When given, a footer action opens the earlier records of the open conversation. */
  readonly onBrowseEarlier?: (() => void) | undefined;
  /** `above` opens the card upwards from a bar docked at the bottom of the screen; the backdrop then covers the whole page. */
  readonly placement?: 'below' | 'above';
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  return <>
    <button type="button" tabIndex={-1} aria-hidden="true" data-testid="conversations-backdrop" onClick={onClose} className={cn('z-20 hidden cursor-default sm:block', placement === 'above' ? 'fixed inset-0' : 'absolute inset-0')} />
    <section role="dialog" aria-label="Conversation history" data-testid="conversations"
      className={cn('fixed inset-0 z-50 flex flex-col bg-background text-foreground sm:absolute sm:inset-auto sm:z-30 sm:w-[23rem] sm:rounded-2xl sm:border sm:border-border sm:shadow-xl',
        placement === 'above' ? 'sm:bottom-full sm:left-0 sm:mb-2 sm:max-h-[min(26rem,60dvh)]' : 'sm:top-12 sm:right-3 sm:max-h-[min(34rem,calc(100%-4rem))]')}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 max-sm:pt-[max(0.625rem,env(safe-area-inset-top))]">
        <Button size="icon-sm" variant="ghost" aria-label="Close history" title="Close" data-testid="conversations-close" onClick={onClose} className="sm:hidden"><ArrowLeftIcon className="size-4" aria-hidden="true" /></Button>
        <h3 className="m-0 min-w-0 flex-1 text-sm font-semibold tracking-tight">History</h3>
        {conversations.onNew && <Button size="sm" variant="outline" data-testid="conversation-new" onClick={() => { conversations.onNew!(); onClose(); }}><PlusIcon className="size-3.5" aria-hidden="true" />New</Button>}
        <Button size="icon-sm" variant="ghost" aria-label="Close history" title="Close" onClick={onClose} className="max-sm:hidden"><XIcon className="size-4" aria-hidden="true" /></Button>
      </header>
      <ConversationList conversations={conversations} onPicked={onClose} autoFocus />
      {onBrowseEarlier && <footer className="shrink-0 border-t border-border p-1.5 max-sm:pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        <Button size="sm" variant="ghost" data-testid="history-earlier" className="w-full justify-start text-muted-foreground" onClick={() => { onBrowseEarlier(); onClose(); }}>
          <HistoryIcon className="size-3.5" aria-hidden="true" />Earlier messages in this conversation</Button>
      </footer>}
    </section>
  </>;
}

function line(message: Message, developer: boolean): { readonly role: string; readonly body: string } | undefined {
  if (message.role === 'system') return developer ? { role: 'System', body: typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join('\n') } : undefined;
  if (message.role === 'toolResult') return { role: `Tool result: ${message.toolName}${message.isError ? ' (failed)' : ''}`, body: message.content.map(part => part.type === 'text' ? part.text : '[image result]').join('\n') };
  if (message.role === 'user') return { role: 'You', body: typeof message.content === 'string' ? message.content : message.content.filter(part => part.type !== 'text' || !isFileBlock(part.text)).map(part => part.type === 'text' ? part.text : '[image attachment]').join('\n') };
  const body = message.content.map(part => part.type === 'text' ? part.text : part.type === 'toolCall' ? `[tool call: ${part.name}]` : developer ? `[reasoning]\n${part.thinking}` : '').filter(Boolean).join('\n\n');
  return { role: message.stopReason === 'aborted' ? 'Assistant (interrupted)' : message.stopReason === 'error' ? 'Assistant (failed)' : 'Assistant', body };
}

/** Read-only older records of the open conversation, paged in by the controller. Historical tool results are not current actions. */
export function HistoryPanel({ history, developer, connected, onLoad, onClose }: {
  readonly history: ChatHistoryState; readonly developer: boolean; readonly connected: boolean; readonly onLoad: () => void; readonly onClose: () => void;
}) {
  const entries: readonly EntryRecord[] = 'entries' in history ? history.entries : [];
  const rows = entries.flatMap(entry => entry.model?.length
    ? entry.model.flatMap((message, index) => { const made = line(message, developer); return made ? [{ key: `history:${entry.id}:${index}`, ...made }] : []; })
    : [{ key: `history:${entry.id}`, role: 'Event', body: entry.head === undefined ? entry.kind : 'Context boundary' }]);
  const exhausted = history.kind === 'ready' && !history.hasMore;
  return <section aria-label="Earlier messages" data-testid="history" aria-live="off" className="shrink-0 border-b border-border bg-muted/20">
    <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2">
      <HistoryIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-medium">Earlier messages <span className="font-normal text-muted-foreground">(read-only)</span></h3>
      <Button size="sm" variant="outline" data-testid="history-load" onClick={onLoad} disabled={!connected || history.kind === 'loading' || history.kind === 'disabled' || exhausted}>
        {history.kind === 'error' ? 'Retry' : history.kind === 'loading' ? 'Loading…' : 'Load earlier'}</Button>
      <Button size="icon-sm" aria-label="Return to active conversation" title="Return to active conversation" onClick={onClose}><XIcon className="size-4" aria-hidden="true" /></Button>
    </div>
    <div className="mx-auto max-h-[40dvh] max-w-3xl space-y-3 overflow-y-auto px-4 pb-3">
      {history.kind === 'error' && <p role="alert" className="m-0 text-sm text-destructive">Conversation history could not be loaded. The previous page remains visible.</p>}
      {history.kind === 'idle' && <p className="m-0 text-sm text-muted-foreground">Load a page to browse earlier messages.</p>}
      {rows.map(row => <article key={row.key} data-history-row-id={row.key} className="rounded-lg border border-border bg-background/60 px-3 py-2">
        <p className="m-0 mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{row.role}</p>
        <div className="text-sm opacity-90"><Markdown text={row.body} /></div></article>)}
      {history.kind === 'ready' && !rows.length && <p className="m-0 text-sm text-muted-foreground">No records in this history page.</p>}
      {exhausted && <p className="m-0 text-center text-xs text-muted-foreground">Beginning of conversation.</p>}
    </div>
  </section>;
}
