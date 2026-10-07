'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ResourceLocator } from '@boring/files';
import { createResourceClient } from '@boring/files/remote';
import type { ResourceIdentity } from '@boring/files/remote';
import type { NativeChatController } from '@boring/ui/native-chat';
import { PiChat, artifactKey } from '../pi-chat/pi-chat';
import type { ArtifactDescriptor, ArtifactsConfig, ConversationsConfig, PiChatProps } from '../pi-chat/pi-chat';
import { ArtifactWorkspace } from '../pi-workspace/workspace';
import type { WorkspacePanelApi } from '../pi-workspace/workspace';
import { ViewerWindowProvider } from '../viewers/viewer-frame';
import type { ViewerShare } from '../viewers/viewer-frame';
import type { InteractiveHtml } from '../viewers/interactive-html';
import { cn } from '../utils/utils';
import { ArtifactPanel, useArtifactVersions, useTurn } from './artifact-panel';
import type { CustomViewers, SavedRevision, ViewerOptions } from './artifact-panel';
import { FileViewer } from './file-viewer';
import { SessionsPane, SessionsToggle } from './sessions';

export { ArtifactPanel, useArtifactVersions, useTurn } from './artifact-panel';
export type { CustomViewerProps, CustomViewers, SavedRevision, ViewerOptions } from './artifact-panel';
export { FileViewer } from './file-viewer';
export { SessionsPane, SessionsToggle } from './sessions';
export { useConversations } from './use-conversations';
export { useRemoteChat } from './use-remote-chat';
export type { RemoteChatState } from './use-remote-chat';
export { savedLabel, useSaved } from './use-saved';
export { kindOf, mediaTypeOf } from './file-kinds';
export type { FileKind } from './file-kinds';

/** An artifact version in the panel: `follow` shows the latest saved revision, otherwise `descriptor.revision` is pinned and read-only. */
export interface ArtifactView { readonly kind: 'artifact'; readonly conversation: string; readonly descriptor: ArtifactDescriptor; readonly follow: boolean }
/** A file in the panel, by the host's path (see `resources.locate`). */
export interface FileView { readonly kind: 'file'; readonly path: string }
/** Anything else the host renders in the panel through `panels[kind]` (for example a file list or a tool view). */
export interface HostView { readonly kind: string; readonly [field: string]: unknown }
/** What the right-hand panel shows, or `null` when it is closed. */
export type OpenedView = ArtifactView | FileView | HostView;

const isArtifact = (view: OpenedView | null): view is ArtifactView => view?.kind === 'artifact';
const isFile = (view: OpenedView | null): view is FileView => view?.kind === 'file';

/** Where the viewers read and write: the host's resource handler (`createResourceHandler` of `@boring/files/remote`) and its file history. */
export interface WorkspaceResources {
  /** The resource handler endpoint. */
  readonly endpoint: string | URL;
  /** The host's authenticated fetch, also used for `history`. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** The person's identity as the resource handler authenticates it (comparison metadata, never a grant). */
  readonly identity: ResourceIdentity;
  /** Optional `GET <history>?path=<resource path>` returning `{ saves: [{ revision, savedAt }] }` newest first (`files.saves(path)`): the version menu. */
  readonly history?: string | URL | undefined;
  /** The resource of a file path in a `FileView`. Default: the published `workspace` provider at the path without a leading slash. */
  readonly locate?: ((path: string) => ResourceLocator) | undefined;
}

export interface AgentWorkspaceProps {
  /** The open conversation's controller (`useRemoteChat`); `undefined` while connecting, when `connecting` is shown instead. */
  readonly controller: NativeChatController | undefined;
  /** The open conversation: auto-opened artifacts and the artifact view belong to it. */
  readonly conversationId: string | undefined;
  /** Everything else `PiChat` takes (title, mode, actions, slash, mentions, attachments, model, effort, emptyState, ...). */
  readonly chat?: Omit<PiChatProps, 'controller' | 'artifacts' | 'conversations' | 'historyList'>;
  readonly connecting?: ReactNode;
  /** The sessions pane (`useConversations`). Omit it for a page without one. Replies keep their Fork button through `conversations.fork`. */
  readonly conversations?: ConversationsConfig | undefined;
  readonly sessionsTitle?: string;
  readonly resources: WorkspaceResources;
  /** Recognise artifacts in tool results that carry no descriptor (`ArtifactsConfig.detect`). */
  readonly detect?: ArtifactsConfig['detect'] | undefined;
  /** Host viewers by artifact type or file kind, for example `{ canvas: props => <MyCanvas {...props} /> }`. */
  readonly viewers?: CustomViewers | undefined;
  /** Run HTML pages in the viewers' sandboxed preview, loading scripts only from these origins. Off without it. */
  readonly interactive?: InteractiveHtml | undefined;
  /** The viewer bar's Share action; it receives `target` `{ artifact, version }` or `{ file }`. */
  readonly share?: ViewerShare | undefined;
  /** Controlled panel content (with `onOpenedChange`); uncontrolled from `defaultOpened` otherwise. */
  readonly opened?: OpenedView | null | undefined;
  readonly defaultOpened?: OpenedView | null | undefined;
  readonly onOpenedChange?: ((next: OpenedView | null) => void) | undefined;
  /** Renderers for host views, by `kind`. */
  readonly panels?: Readonly<Record<string, (view: HostView, panel: WorkspacePanelApi) => ReactNode>> | undefined;
  /** Open the panel on each artifact (or new version) the agent makes, unless the person closed it during this turn. Not on a phone. Default true. */
  readonly autoOpen?: boolean;
  /** A back button in a file's viewer bar (for example to the host's file list). */
  readonly fileBack?: { readonly label: string; readonly onBack: () => void } | undefined;
  /** With `floatBelow`: the floating chat over the same session (for example `AmbientChat` of `pi-ambient` with `onDock={dock}`). */
  readonly floatingChat?: ((props: PiChatProps, dock: () => void) => ReactNode) | undefined;
  /** Shown above the chat (notices). */
  readonly chatTop?: ReactNode;
  /** The chat header's controls; a function receives whether the panel is open. */
  readonly controls?: ReactNode | ((state: { readonly panelOpen: boolean }) => ReactNode);
  /** Prefix of the session-scoped layout keys (panel width, floating chat, collapsed sessions). */
  readonly storageKey?: string;
  /** Below this width of the workspace the artifact panel is a full-screen sheet. */
  readonly sheetBelow?: number;
  /** Below this width of the workspace the sessions pane is a drawer. */
  readonly drawerBelow?: number;
  readonly floatBelow?: number | undefined;
  readonly className?: string;
}

const SESSIONS_WIDTH = 288;
const readFlag = (key: string): boolean => { try { return sessionStorage.getItem(key) === '1'; } catch { return false; } };
const writeFlag = (key: string, on: boolean) => { try { if (on) sessionStorage.setItem(key, '1'); else sessionStorage.removeItem(key); } catch { /* the layout is a convenience */ } };
const defaultLocate = (path: string): ResourceLocator => ({ resource: { providerId: 'workspace', path: path.replace(/^\/+/, '') }, view: { kind: 'published' } });

/**
 * A complete agent page in one component: the sessions pane on the left (search, New, rename, archive, delete; collapsible, a drawer on
 * a narrow screen), the chat in the center (`PiChat`) and the artifact viewers on the right (`ArtifactWorkspace` with the artifact panel and
 * its versions, the file viewer and the host's own views). Agent artifacts open the panel as they appear. Every prop is data or a callback:
 * the host owns the routes, authentication, the controller and what is open (when controlled).
 */
export function AgentWorkspace({ controller, conversationId, chat = {}, connecting, conversations, sessionsTitle, resources, detect, viewers, interactive, share, opened: controlled,
  defaultOpened = null, onOpenedChange, panels, autoOpen = true, fileBack, floatingChat, chatTop, controls, storageKey = 'boring.agent-workspace', sheetBelow = 768, drawerBelow = 768, floatBelow, className }: AgentWorkspaceProps) {
  const [own, setOwn] = useState<OpenedView | null>(defaultOpened);
  const opened = controlled !== undefined ? controlled : own;
  const change = useRef(onOpenedChange); change.current = onOpenedChange;
  const isControlled = controlled !== undefined;
  const setOpened = useCallback((next: OpenedView | null) => { if (!isControlled) setOwn(next); change.current?.(next); }, [isControlled]);
  const [fullscreen, setFullscreen] = useState(false);

  // One resource client and one history reader for every viewer, over the host's authenticated fetch.
  const fetcher = useRef(resources.fetch); fetcher.current = resources.fetch;
  const endpoint = String(resources.endpoint), historyEndpoint = resources.history === undefined ? undefined : String(resources.history);
  const identityKey = JSON.stringify(resources.identity);
  const client = useMemo(() => createResourceClient({ identity: resources.identity, endpoint: new URL(endpoint, globalThis.location?.href), publication: true, reconciliation: true,
    fetch: request => fetcher.current(request) }), [endpoint, identityKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const history = useMemo(() => historyEndpoint === undefined ? undefined : async (path: string): Promise<readonly SavedRevision[]> => {
    const url = new URL(historyEndpoint, globalThis.location?.href);
    url.searchParams.set('path', path);
    const response = await fetcher.current(new Request(url));
    if (!response.ok) throw new Error(`History: ${response.status}`);
    return (await response.json() as { saves: readonly SavedRevision[] }).saves;
  }, [historyEndpoint]);
  const options: ViewerOptions = useMemo(() => ({ client, identity: resources.identity, history, viewers, interactive, share }), [client, history, viewers, interactive, share]); // eslint-disable-line react-hooks/exhaustive-deps
  const locate = resources.locate ?? defaultLocate;

  // ---- Artifacts: cards open the panel; the agent's new ones open it too.
  const versions = useArtifactVersions(controller, detect);
  const turn = useTurn(controller);
  const active = isArtifact(opened) && opened.conversation === conversationId ? opened : null;
  const file = isFile(opened) ? opened : null;
  const host = opened && !isArtifact(opened) && !isFile(opened) && panels?.[opened.kind] ? opened : null;
  const panelOpen = Boolean(active || file || host);
  const seen = useRef(new Map<string, Set<string>>());
  const closedInTurn = useRef(new Map<string, number>());
  const close = () => { if (conversationId !== undefined) closedInTurn.current.set(conversationId, turn); setOpened(null); setFullscreen(false); };
  useEffect(() => {
    if (!controller || conversationId === undefined) return;
    const keys = versions.map(version => `${artifactKey(version)}:${version.revision}`);
    const known = seen.current.get(conversationId);
    // What the conversation already held when it loaded does not count.
    if (!known) { seen.current.set(conversationId, new Set(keys)); return; }
    const fresh = versions.filter(version => !known.has(`${artifactKey(version)}:${version.revision}`));
    for (const key of keys) known.add(key);
    if (!autoOpen || !fresh.length || closedInTurn.current.get(conversationId) === turn || globalThis.matchMedia?.(`(max-width: ${sheetBelow - 1}px)`).matches) return;
    setOpened({ kind: 'artifact', conversation: conversationId, descriptor: fresh.at(-1)!, follow: true });
  }, [versions, controller, conversationId, turn]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The versions of one file that the conversation presented or saved, newest first. */
  const newestOf = (key: string) => versions.filter(version => artifactKey(version) === key).reverse();
  const artifacts: ArtifactsConfig = useMemo(() => ({
    open: descriptor => { if (conversationId !== undefined) setOpened({ kind: 'artifact', conversation: conversationId, descriptor, follow: descriptor.revision === newestOf(artifactKey(descriptor))[0]?.revision }); },
    isOpen: descriptor => Boolean(active && artifactKey(active.descriptor) === artifactKey(descriptor) && (active.follow ? descriptor.revision === newestOf(artifactKey(descriptor))[0]?.revision : descriptor.revision === active.descriptor.revision)),
    ...(detect ? { detect } : {}),
  }), [conversationId, active, versions, detect, setOpened]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Sessions: docked on a wide workspace (collapsible, remembered for the session), a drawer on a narrow one.
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const narrow = width > 0 && width < drawerBelow;
  const [collapsed, setCollapsed] = useState(() => readFlag(`${storageKey}.sessions-hidden`));
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { if (!narrow) setDrawer(false); }, [narrow]);
  const docked = Boolean(conversations) && width > 0 && !narrow && !collapsed;
  const toggle = conversations && <SessionsToggle open={narrow ? drawer : !collapsed} drawer={narrow}
    onToggle={() => { if (narrow) setDrawer(value => !value); else setCollapsed(value => { writeFlag(`${storageKey}.sessions-hidden`, !value); return !value; }); }} />;

  // ---- The chat in the center: docked PiChat, or the host's floating surface over the same controller.
  const header = typeof controls === 'function' ? controls({ panelOpen }) : controls ?? chat.controls;
  const chatProps: PiChatProps | undefined = controller && { ...chat, controller, artifacts, ...(conversations ? { conversations, historyList: false } : {}),
    headerStart: <>{toggle}{chat.headerStart}</>, ...(header === undefined ? {} : { controls: header }) };
  const docked_chat = <div data-testid="workspace-center" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    {chatTop}
    {chatProps ? <PiChat key={conversationId} {...chatProps} className={cn('min-h-0 flex-1', chat.className)} />
      : <>{toggle && <div className="flex shrink-0 items-center border-b border-border px-3 py-2">{toggle}</div>}{connecting}</>}
  </div>;

  const kind = active ? 'artifact' : file ? 'file' : host?.kind;
  return <div ref={root} data-boring="agent-workspace" data-sessions={!conversations ? undefined : narrow ? (drawer ? 'drawer' : 'closed') : docked ? 'docked' : 'hidden'}
    className={cn('relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden', className)}>
    {conversations && (docked || (narrow && drawer)) && <SessionsPane conversations={conversations} {...(sessionsTitle ? { title: sessionsTitle } : {})} drawer={narrow} onClose={() => setDrawer(false)} />}
    <ArtifactWorkspace open={panelOpen} onClose={close} fullscreen={fullscreen} onFullscreenChange={setFullscreen} storageKey={`${storageKey}.panel-width`}
      sheetBelow={docked ? Math.max(0, sheetBelow - SESSIONS_WIDTH) : sheetBelow} {...(floatBelow === undefined ? {} : { floatBelow })}
      chat={layout => layout.floating && floatingChat && chatProps ? floatingChat(chatProps, layout.dock) : docked_chat}
      panel={win => <ViewerWindowProvider value={{ fullscreen: win.fullscreen, onFullscreenChange: win.onFullscreenChange, onFloatChat: win.floatChat }}>
        <div data-testid="viewer-panel" data-kind={kind} className="flex min-h-0 flex-1 flex-col overflow-hidden [&>*]:min-h-0 [&>*]:flex-1">
          {active
            ? <ArtifactPanel key={artifactKey(active.descriptor)} active={active} versions={newestOf(artifactKey(active.descriptor))} options={options} onClose={win.close}
                onSelect={value => {
                  const known = newestOf(artifactKey(active.descriptor));
                  setOpened({ kind: 'artifact', conversation: active.conversation, follow: value === 'latest', descriptor: value === 'latest' ? (known[0] ?? active.descriptor) : { ...active.descriptor, revision: value } });
                }} />
            : file ? <FileViewer key={file.path} path={file.path} locator={locate(file.path)} options={options} onClose={win.close} {...(fileBack ? { onBack: fileBack.onBack, backLabel: fileBack.label } : {})} />
            : host ? panels![host.kind]!(host, win) : null}
        </div></ViewerWindowProvider>} />
  </div>;
}
