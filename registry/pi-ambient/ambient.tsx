'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ImageContent, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { NativeChatController } from '@boring/ui/native-chat';
import { ArrowDownIcon, BellIcon, ChevronDownIcon, ExternalLinkIcon, GripVerticalIcon, Loader2Icon, MinusIcon, PanelLeftIcon, RefreshCwIcon, ThumbsDownIcon, ThumbsUpIcon } from 'lucide-react';
import { Button } from '../button/button';
import { CopyButton } from '../pi-chat/code-block';
import { Composer } from '../pi-chat/composer';
import type { ComposerFeedback } from '../pi-chat/composer';
import type { AttachmentsConfig, ConversationsConfig, EffortConfig, MentionsConfig, ModelConfig, SlashConfig } from '../pi-chat/config';
import { notifyPermission, requestNotifyPermission } from './browser-notify';
import type { NotifyPermission } from './browser-notify';
import { ConversationHistory } from '../pi-chat/history';
import type { CommandMentions } from '../pi-chat/markdown';
import { RowView } from '../pi-chat/message';
import type { RowContext } from '../pi-chat/message';
import { ChatNotices, Notice } from '../pi-chat/notice';
import { AgentNotifications, KindIcon, createNotificationStore, finishNotice, pendingQuestion, useNotifications } from './notifications';
import type { AgentNotification, NotificationStore } from './notifications';
import { MessageQueue } from '../pi-chat/queue';
import { artifactKey, collectArtifacts } from '../pi-chat/artifact';
import type { ArtifactDescriptor, ArtifactsConfig } from '../pi-chat/artifact';
import type { ChatCard, Mode } from '../pi-chat/rows';
import { useChatSession, useTranscript } from '../pi-chat/session';
import type { ChatFeatureProps, ChatSession } from '../pi-chat/session';
import { ArtifactWorkspace } from '../pi-workspace/workspace';
import type { WorkspacePanelApi } from '../pi-workspace/workspace';
import { cn } from '../utils/utils';

export { AgentNotifications, createNotificationStore, summaryOf, useNotifications, watchConversation } from './notifications';
export type { AgentNotification, AgentNotificationsProps, NewNotification, NotificationKind, NotificationStore } from './notifications';

/** `bar` is the compact bar, `expanded` the same window grown into a chat, `minimized` a small pill. */
export type AmbientState = 'bar' | 'expanded' | 'minimized';

/** What the artifact panel inside the window gets besides the full-screen and close controls: the versions of the open artifact and how to switch. */
export interface AmbientArtifactPanelApi extends WorkspacePanelApi {
  /** Every known version of the open artifact in this conversation, newest first. */
  readonly versions: readonly ArtifactDescriptor[];
  /** True while the panel follows the newest version; false when one older version is pinned. */
  readonly follow: boolean;
  /** `'latest'` follows the newest version; a descriptor from `versions` pins that one. */
  readonly select: (version: ArtifactDescriptor | 'latest') => void;
}

export interface AmbientChatProps extends ChatFeatureProps {
  readonly controller: NativeChatController;
  /** Shown while the conversation has no title of its own (the active item of `conversations` provides one). */
  readonly title?: string;
  /** `contrast` is a dark window on any page; `surface` follows the host's background. */
  readonly variant?: 'contrast' | 'surface';
  /** Input placeholder while idle. While the agent works it reads "Working for 40s" (see `workingLabel`). */
  readonly placeholder?: string;
  readonly workingLabel?: (seconds: number) => string;
  /** Controlled window state; otherwise `defaultState` starts it and the window keeps it. */
  readonly state?: AmbientState;
  readonly defaultState?: AmbientState;
  readonly onStateChange?: (state: AmbientState) => void;
  /** Where the bar was dragged is remembered for this browser session under this key. */
  readonly storageKey?: string;
  /** Host controls in the composer row, between the effort picker and Send (for example a voice button the host guards itself). Absent: nothing is shown. */
  readonly tools?: ReactNode;
  /** Hand the conversation to a full `PiChat` or `ArtifactWorkspace`. Adds an "Open in full chat" action to replies. */
  readonly onOpenFull?: (conversationId: string) => void;
  /** Adds thumbs up and down to replies. `value` is `null` when the person takes the rating back. */
  readonly onFeedback?: (reply: { readonly key: string; readonly text: string }, value: 'up' | 'down' | null) => void;
  /** Toasts for finished, failed and waiting tasks. Pass a store to feed it for background conversations too; `false` turns them off. */
  readonly notifications?: NotificationStore | false;
  readonly autoDismissMs?: number;
  readonly maxToasts?: number;
  /** System notifications while the page is hidden. A bell in the header asks for permission when the person chooses to; nothing is asked on load. */
  readonly systemNotifications?: boolean;
  /**
   * The viewer shown inside the window when an artifact card is opened: the window widens into chat on the left and this panel on the right
   * (`ArtifactWorkspace`: draggable divider, full screen, a full-screen sheet on a phone). Build it from the viewer registry (`ViewerFrame`, ...),
   * wrapped in `ViewerWindowProvider` with `api.fullscreen` / `api.onFullscreenChange` so its bar shows the full screen button.
   */
  readonly artifactPanel?: (artifact: ArtifactDescriptor, api: AmbientArtifactPanelApi) => ReactNode;
  /** `window` (default when `artifactPanel` is given) opens artifacts inside the window; `host` calls `artifacts.open` instead, for hosts that show them in their own viewer. */
  readonly artifactTarget?: 'window' | 'host';
  /** The title's ⌄ opens this list to switch conversations or tasks. */
  readonly conversations?: ConversationsConfig;
  /** Adds a "Dock chat" action to the header, for a host that floats this window out of a docked chat (`ArtifactWorkspace` with `floatBelow`). It shares the controller with the docked `PiChat`, so nothing is lost. */
  readonly onDock?: () => void;
  /** The optional Feedback button in the composer (the registry `feedback` item's `useComposerFeedback`). Omit it and nothing changes. */
  readonly feedback?: ComposerFeedback;
  readonly className?: string;
}

interface Position { readonly right: number; readonly bottom: number }
const MARGIN = 8, DEFAULT_POSITION: Position = { right: 16, bottom: 16 };

function readPosition(key: string): Position | undefined {
  try {
    const value: unknown = JSON.parse(globalThis.sessionStorage.getItem(key) ?? 'null');
    const { right, bottom } = (value ?? {}) as { right?: unknown; bottom?: unknown };
    return typeof right === 'number' && typeof bottom === 'number' && Number.isFinite(right) && Number.isFinite(bottom) ? { right, bottom } : undefined;
  } catch { return undefined; }
}
function writePosition(key: string, position: Position) {
  try { globalThis.sessionStorage.setItem(key, JSON.stringify(position)); } catch { /* the position is a convenience */ }
}
const clamp = (position: Position, size: { w: number; h: number }, viewport: { w: number; h: number }): Position => ({
  right: Math.round(Math.min(Math.max(MARGIN, position.right), Math.max(MARGIN, viewport.w - size.w - MARGIN))),
  bottom: Math.round(Math.min(Math.max(MARGIN, position.bottom), Math.max(MARGIN, viewport.h - size.h - MARGIN))),
});

// The layout viewport that fixed positioning uses (without scrollbars), not the window's outer size.
const viewportSize = () => { const root = globalThis.document?.documentElement; return { w: root?.clientWidth || globalThis.innerWidth || 1024, h: root?.clientHeight || globalThis.innerHeight || 768 }; };
function usePhone(): boolean {
  const query = '(max-width: 639px)';
  const [phone, setPhone] = useState(() => globalThis.matchMedia?.(query).matches === true);
  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) return;
    const update = () => setPhone(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return phone;
}

/** Whole seconds since `active` became true; 0 while inactive. */
function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) { setSeconds(0); return; }
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}
const elapsedText = (seconds: number) => seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;

/** Pushes a toast when a run finishes or fails and when a question starts waiting; takes it back when the question is answered or a new run starts. */
function useRunFeed({ enabled, store, conversationId, title, session, suppress, onOutcome }: {
  readonly enabled: boolean; readonly store: NotificationStore; readonly conversationId: string; readonly title: string; readonly session: ChatSession;
  readonly suppress: () => boolean; readonly onOutcome: (outcome: 'done' | 'error' | null) => void;
}) {
  const { working, waitingForAnswer, rows, connected } = session;
  const before = useRef({ working, waiting: waitingForAnswer });
  const latest = useRef({ rows, title, suppress, onOutcome, connected });
  latest.current = { rows, title, suppress, onOutcome, connected };
  useEffect(() => {
    const was = before.current;
    before.current = { working, waiting: waitingForAnswer };
    const now = latest.current;
    if (working && !was.working) { now.onOutcome(null); store.dismiss(`${conversationId}:done`); }
    if (!enabled) return;
    if (waitingForAnswer && !was.waiting && !now.suppress()) store.push({ id: `${conversationId}:input`, kind: 'input', title: now.title, summary: pendingQuestion(now.rows) ?? 'Waiting for your answer', conversationId });
    if (!waitingForAnswer && was.waiting) store.dismiss(`${conversationId}:input`);
    if (was.working && !working && now.connected) {
      const finished = finishNotice(now.rows);
      if (!finished) return;
      now.onOutcome(finished.kind);
      if (!now.suppress()) store.push({ id: `${conversationId}:done`, kind: finished.kind, title: now.title, summary: finished.summary, conversationId });
    }
  }, [working, waitingForAnswer, enabled, store, conversationId]);
}

/** A compact floating agent bar over an existing page; it grows into a chat window in place. Borrows a concrete native controller like `PiChat`. */
export function AmbientChat(props: AmbientChatProps) {
  const active = useRef(props.controller); active.current = props.controller;
  const [mount, setMount] = useState({ controller: props.controller, sequence: 0 });
  if (mount.controller !== props.controller) setMount({ controller: props.controller, sequence: mount.sequence + 1 });
  // The window state and the toasts belong to the bar, not to one conversation: they survive switching conversations.
  const [local, setLocal] = useState<AmbientState>(props.defaultState ?? 'bar');
  const internalStore = useMemo(createNotificationStore, []);
  return <AmbientSession key={mount.sequence} {...props} activeController={active} windowState={props.state ?? local} store={props.notifications || internalStore}
    onWindowState={next => { if (props.state === undefined) setLocal(next); props.onStateChange?.(next); }} />;
}

const iconButton = 'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 max-sm:size-11 pointer-coarse:size-11 motion-reduce:transition-none';

type SessionProps = AmbientChatProps & { readonly activeController: { readonly current: NativeChatController }; readonly windowState: AmbientState; readonly store: NotificationStore; readonly onWindowState: (state: AmbientState) => void };

function AmbientSession({ controller, title = 'Agent', variant = 'contrast', mode = 'expert', actions, placeholder = 'Do anything', workingLabel = seconds => `Working for ${elapsedText(seconds)}`,
  windowState, onWindowState, store, storageKey = 'boring.ambient.position', tools, onOpenFull, onFeedback, notifications, autoDismissMs, maxToasts, systemNotifications = false,
  renderEntry, renderTool, groupTool, commandMentions, onOpenImage, onCopy, onComposerKeyDown, fileAccept = 'image/*', slash, mentions, attachments, model, effort, artifacts: hostArtifacts, artifactPanel, artifactTarget, conversations, onDock, feedback: composerFeedback, className,
  activeController }: SessionProps) {
  const stateRef = useRef(windowState); stateRef.current = windowState;
  // The artifact open inside the window, and whether it follows the newest version. It belongs to the expanded window: leaving that state closes it.
  const [opened, setOpened] = useState<{ readonly descriptor: ArtifactDescriptor; readonly follow: boolean } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const setWindowState = (next: AmbientState) => {
    if (next !== 'expanded') { setOpened(null); setFullscreen(false); }
    if (next !== stateRef.current) onWindowState(next);
  };
  const expanded = windowState === 'expanded', minimized = windowState === 'minimized';
  const phone = usePhone();
  const root = useRef<HTMLDivElement>(null), titleButton = useRef<HTMLButtonElement>(null), pill = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const [feedback, setFeedback] = useState<Readonly<Record<string, 'up' | 'down'>>>({});
  const [outcome, setOutcome] = useState<'done' | 'error' | null>(null);
  const [permission, setPermission] = useState<NotifyPermission>('unsupported');
  useEffect(() => { setPermission(notifyPermission()); }, []);
  useEffect(() => { if (!outcome) return; const timer = setTimeout(() => setOutcome(null), 8000); return () => clearTimeout(timer); }, [outcome]);

  // Replies get copy, optional feedback and the time; the host may hand the conversation to its full chat.
  const conversationRef = useRef('');
  const replyActions = useMemo<NonNullable<RowContext['replyActions']>>(() => reply => <div data-testid="reply-actions" className="mt-2 -ml-2 flex items-center gap-0.5 text-muted-foreground">
    <CopyButton text={reply.text} label="Copy response" iconOnly {...(onCopy ? { onCopy } : {})} className="size-8 p-0 text-muted-foreground max-sm:size-11" />
    {onFeedback && <>
      {(['up', 'down'] as const).map(value => <button key={value} type="button" data-testid={`feedback-${value}`} aria-pressed={feedback[reply.key] === value} aria-label={value === 'up' ? 'Good response' : 'Bad response'}
        title={value === 'up' ? 'Good response' : 'Bad response'}
        onClick={() => { const next = feedback[reply.key] === value ? null : value; setFeedback(current => { const { [reply.key]: _removed, ...rest } = current; return next ? { ...rest, [reply.key]: next } : rest; }); onFeedback({ key: reply.key, text: reply.text }, next); }}
        className={cn(iconButton, 'aria-pressed:text-foreground')}>{value === 'up' ? <ThumbsUpIcon className="size-3.5" aria-hidden="true" /> : <ThumbsDownIcon className="size-3.5" aria-hidden="true" />}</button>)}
    </>}
    {onOpenFull && <button type="button" data-testid="open-full" aria-label="Open in full chat" title="Open in full chat" onClick={() => onOpenFull(conversationRef.current)} className={iconButton}><ExternalLinkIcon className="size-3.5" aria-hidden="true" /></button>}
    {reply.timestamp !== undefined && <time dateTime={new Date(reply.timestamp).toISOString()} data-testid="reply-time" className="ml-1.5 text-xs tabular-nums">{new Date(reply.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>}
  </div>, [onCopy, onFeedback, onOpenFull, feedback]);
  const scrollToBottom = useRef<() => void>(() => {});
  const rowExtras = useMemo(() => ({ replyActions }), [replyActions]);
  const inWindow = Boolean(artifactPanel) && artifactTarget !== 'host';
  const detect = hostArtifacts?.detect;
  const versionsRef = useRef<readonly ArtifactDescriptor[]>([]);
  const artifacts = useMemo<ArtifactsConfig | undefined>(() => !inWindow ? hostArtifacts : {
    open: descriptor => { const newest = versionsRef.current.filter(version => artifactKey(version) === artifactKey(descriptor)).reduce((top, version) => Math.max(top, version.ordinal ?? 0), 0); setOpened({ descriptor, follow: (descriptor.ordinal ?? 0) >= newest }); },
    isOpen: descriptor => opened !== null && artifactKey(opened.descriptor) === artifactKey(descriptor) && (opened.follow ? (descriptor.ordinal ?? 0) >= (versionsRef.current.find(version => artifactKey(version) === artifactKey(descriptor))?.ordinal ?? 0) : descriptor.revision === opened.descriptor.revision),
    ...(detect ? { detect } : {}),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inWindow, hostArtifacts, opened, detect]);
  const session = useChatSession({ controller, activeController, mode, actions, renderEntry, renderTool, groupTool, commandMentions, onOpenImage, onCopy, onComposerKeyDown, fileAccept,
    slash, mentions, attachments, model, effort, artifacts, afterSend: () => scrollToBottom.current(), rowExtras, feedback: composerFeedback });
  const { state, derived, rows, queued, queueActions, working, waitingForAnswer, error, act, textarea, rowContext, composer, empty, loading } = session;
  const transcript = useTranscript(rows);
  const versions = useMemo(() => inWindow ? collectArtifacts(state.view, detect).sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0)) : [], [inWindow, state.view, detect]);
  versionsRef.current = versions;
  const known = opened ? versions.filter(version => artifactKey(version) === artifactKey(opened.descriptor)) : [];
  const shownArtifact = opened ? (opened.follow ? known[0] ?? opened.descriptor : opened.descriptor) : undefined;
  const { stick, hidden } = transcript;
  scrollToBottom.current = () => { void stick.scrollToBottom('instant'); };
  const { barStart, barNote } = session.pickers();

  const conversationId = String(conversations?.activeId ?? state.conversationId);
  conversationRef.current = conversationId;
  const activeItem = conversations?.items.find(item => item.id === conversations.activeId);
  const shownTitle = activeItem?.title?.trim() || title;
  const toasts = useNotifications(store);
  useRunFeed({ enabled: notifications !== false, store, conversationId, title: shownTitle, session, onOutcome: setOutcome,
    suppress: () => stateRef.current === 'expanded' && globalThis.document?.visibilityState !== 'hidden' });
  const unread = !expanded && toasts.length > 0;
  const seconds = useElapsed(working);

  // Position: offsets from the bottom right corner, remembered for the session, clamped to the viewport at render so a smaller window restores them.
  const [position, setPosition] = useState<Position>(() => readPosition(storageKey) ?? DEFAULT_POSITION);
  const [viewport, setViewport] = useState(viewportSize);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const onResize = () => setViewport(viewportSize());
    globalThis.addEventListener('resize', onResize);
    return () => globalThis.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setSize({ w: element.offsetWidth, h: element.offsetHeight }));
    observer.observe(element);
    setSize({ w: element.offsetWidth, h: element.offsetHeight });
    return () => observer.disconnect();
  }, [minimized, expanded]);
  // The size and the viewport also follow every render, so the clamp below never works from a stale measurement (the title or status icon can change the pill's width; a scrollbar can appear without a resize event).
  useLayoutEffect(() => {
    const element = root.current;
    const fresh = viewportSize();
    setViewport(current => current.w === fresh.w && current.h === fresh.h ? current : fresh);
    if (element) setSize(current => current.w === element.offsetWidth && current.h === element.offsetHeight ? current : { w: element.offsetWidth, h: element.offsetHeight });
  });
  const placed = clamp(position, size, viewport);
  // Moves and the release are followed on the window, so a drag keeps working when the pointer leaves the handle (and when pointer capture is unavailable).
  // `threshold` is how far the pointer must travel before it is a drag: a click on the pill (threshold > 0) still restores it.
  const dragged = useRef(false);
  const beginDrag = (event: PointerEvent<HTMLElement>, threshold: number) => {
    if (phone || event.button !== 0) return;
    dragged.current = false;
    const origin = { pointer: event.pointerId, x: event.clientX, y: event.clientY, start: placed };
    let last = origin.start, moving = threshold === 0;
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== origin.pointer) return;
      if (!moving) { if (Math.hypot(next.clientX - origin.x, next.clientY - origin.y) < threshold) return; moving = true; dragged.current = true; }
      last = clamp({ right: origin.start.right - (next.clientX - origin.x), bottom: origin.start.bottom - (next.clientY - origin.y) }, size, viewport);
      setPosition(last);
    };
    const end = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== origin.pointer) return;
      globalThis.removeEventListener('pointermove', move); globalThis.removeEventListener('pointerup', end); globalThis.removeEventListener('pointercancel', end);
      if (moving) writePosition(storageKey, last);
    };
    globalThis.addEventListener('pointermove', move); globalThis.addEventListener('pointerup', end); globalThis.addEventListener('pointercancel', end);
  };
  const onGripDown = (event: PointerEvent<HTMLButtonElement>) => { event.preventDefault(); beginDrag(event, 0); };
  // Arrow keys move the window (Shift for big steps); Home puts it back in the default corner.
  const onGripKey = (event: KeyboardEvent<HTMLElement>) => {
    if (phone) return;
    const step = event.shiftKey ? 64 : 16;
    const delta = event.key === 'ArrowLeft' ? { right: step, bottom: 0 } : event.key === 'ArrowRight' ? { right: -step, bottom: 0 } : event.key === 'ArrowUp' ? { right: 0, bottom: step } : event.key === 'ArrowDown' ? { right: 0, bottom: -step } : undefined;
    if (!delta && event.key !== 'Home') return;
    event.preventDefault();
    const next = delta ? clamp({ right: placed.right + delta.right, bottom: placed.bottom + delta.bottom }, size, viewport) : clamp(DEFAULT_POSITION, size, viewport);
    setPosition(next); writePosition(storageKey, next);
  };
  const grip = (className?: string) => <button type="button" data-testid="ambient-grip" aria-label="Move the agent window (arrow keys, Home resets)" title="Drag to move" onPointerDown={onGripDown} onKeyDown={onGripKey}
    className={cn(iconButton, 'cursor-grab touch-none active:cursor-grabbing', className)}><GripVerticalIcon className="size-4" aria-hidden="true" /></button>;

  const expand = () => { setOutcome(null); store.dismissConversation(conversationId); setWindowState('expanded'); };
  useEffect(() => {
    if (expanded && !globalThis.matchMedia?.('(pointer: coarse)').matches) textarea.current?.focus();
  }, [expanded, textarea]);
  // The title is disabled while the window is open, so focus goes back to it once the bar is showing again.
  const refocusTitle = useRef(false);
  useEffect(() => { if (!expanded && refocusTitle.current) { refocusTitle.current = false; titleButton.current?.focus(); } }, [expanded]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !expanded || picking) return;
    event.preventDefault();
    // Escape steps back: full screen, then the artifact, then the window.
    if (fullscreen) return setFullscreen(false);
    if (opened) return setOpened(null);
    refocusTitle.current = true;
    setWindowState('bar');
  };
  const onActivate = useCallback((item: AgentNotification) => {
    if (item.conversationId !== undefined && item.conversationId !== conversationId) conversations?.onSelect(item.conversationId);
    expand();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, conversations]);

  const connectionKind = state.connection.kind;
  const status = waitingForAnswer ? 'input' : working ? 'working' : outcome;
  const label = waitingForAnswer ? 'Waiting for your answer' : workingLabel(seconds);
  const panelOpen = expanded && shownArtifact !== undefined && artifactPanel !== undefined;
  const surface = cn('relative flex flex-col border border-border bg-background text-foreground shadow-2xl', phone && expanded ? 'h-dvh rounded-none border-0 pt-[env(safe-area-inset-top)]' : 'rounded-3xl',
    !phone && expanded && (panelOpen ? 'h-full overflow-hidden' : 'max-h-[70dvh]'));
  // With an artifact open the window widens (most of the viewport, at most 72rem) and takes a fixed height so the panel fills it.
  const rootClass = cn('pi-chat pi-ambient fixed z-50', phone ? (expanded ? 'inset-0' : 'inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))]')
    : cn('transition-[width] duration-200 motion-reduce:transition-none', minimized ? 'w-auto' : panelOpen ? 'h-[min(46rem,calc(100dvh-1rem))] w-[min(72rem,calc(100vw-1rem))]' : expanded ? 'w-[min(35rem,calc(100vw-1rem))]' : 'w-[min(26rem,calc(100vw-1rem))]'), className);
  const rootStyle = phone ? undefined : { right: placed.right, bottom: placed.bottom };

  if (minimized) return <div ref={root} data-boring="ambient-chat" data-state="minimized" data-variant={variant} className={cn(rootClass, phone && 'flex justify-end')} style={rootStyle} onKeyDown={onKeyDown}>
    {notifications !== false && <AgentNotifications store={store} variant={variant} placement="inline" systemNotifications={systemNotifications} onActivate={onActivate}
      {...(autoDismissMs !== undefined ? { autoDismissMs } : {})} {...(maxToasts !== undefined ? { max: maxToasts } : {})} className="absolute right-0 bottom-full mb-3 w-[min(26rem,calc(100vw-1rem))]" />}
    {/* Feedback mode keeps its bar (Stop, Done, ✕) when the window is minimised; otherwise a recording could not be stopped. */}
    {composerFeedback?.active && composerFeedback.bar && <div data-testid="ambient-feedback-bar" className="absolute right-0 bottom-full mb-2 w-[min(26rem,calc(100vw-1rem))] rounded-2xl border border-border bg-background pt-2.5 shadow-xl">{composerFeedback.bar}</div>}
    <div data-testid="ambient-pill-box" onPointerDown={event => beginDrag(event, 4)} onKeyDown={onGripKey} onClickCapture={event => { if (dragged.current) { dragged.current = false; event.stopPropagation(); event.preventDefault(); } }}
      className={cn('relative flex h-11 max-w-[min(20rem,calc(100vw-1rem))] items-center rounded-full border border-border bg-background text-foreground shadow-xl transition-colors hover:bg-popover motion-reduce:transition-none', !phone && 'cursor-grab touch-none select-none active:cursor-grabbing')}>
      {!phone && grip('ml-1.5 size-8 rounded-full')}
      <button ref={pill} type="button" data-testid="ambient-pill" onClick={() => setWindowState('bar')} aria-label={`Open agent: ${shownTitle}${unread ? ' (new activity)' : ''}`}
        className={cn('relative flex h-full min-w-0 cursor-pointer items-center gap-2.5 rounded-full pr-4 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70', phone ? 'pl-3.5' : 'pl-1.5')}>
        {status === 'working' ? <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
          : status ? <KindIcon kind={status === 'input' ? 'input' : status} className="size-4" /> : null}
        <span className="min-w-0 truncate text-sm">{shownTitle}</span>
        {unread && <span data-testid="ambient-unread" aria-hidden="true" className="absolute top-1.5 right-2 size-2.5 rounded-full border-2 border-background bg-primary" />}
      </button>
    </div>
  </div>;

  const visibleRows = transcript.visible(rows);
  return <div ref={root} data-boring="ambient-chat" data-state={windowState} data-variant={variant} data-phone={phone ? 'true' : undefined} role="region" aria-label={`Agent: ${shownTitle}`}
    className={rootClass} style={rootStyle} onKeyDown={onKeyDown}>
    {notifications !== false && !(phone && expanded) && <AgentNotifications store={store} variant={variant} placement="inline" systemNotifications={systemNotifications} onActivate={onActivate}
      {...(autoDismissMs !== undefined ? { autoDismissMs } : {})} {...(maxToasts !== undefined ? { max: maxToasts } : {})} className="absolute right-0 bottom-full mb-3 w-full" />}
    {picking && conversations && <ConversationHistory conversations={conversations} placement={expanded ? 'below' : 'above'} onClose={() => setPicking(false)} />}
    <div data-testid="ambient-surface" className={surface}>
    <ArtifactWorkspace open={panelOpen} onClose={() => { setOpened(null); setFullscreen(false); }} fullscreen={fullscreen} onFullscreenChange={setFullscreen} storageKey="boring.ambient.panel-width" panelLabel="Artifact panel"
      defaultWidth={600} minPanel={320} minChat={300} sheetBelow={720}
      panel={api => shownArtifact && artifactPanel ? artifactPanel(shownArtifact, { ...api, versions: known, follow: opened?.follow ?? true,
        select: version => setOpened(current => current ? (version === 'latest' ? { descriptor: known[0] ?? current.descriptor, follow: true } : { descriptor: version, follow: false }) : current) }) : null}
      chat={<section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header data-testid="ambient-header" className={cn('flex h-12 shrink-0 items-center gap-0.5 px-2 max-sm:h-14', !expanded && 'border-b border-border')}>
        <button type="button" data-testid="ambient-minimize" aria-label="Minimise" title="Minimise" onClick={() => { setPicking(false); setWindowState(expanded ? 'bar' : 'minimized'); }} className={iconButton}><MinusIcon className="size-4" aria-hidden="true" /></button>
        <span data-testid="ambient-status" data-status={status ?? 'idle'} role="img" aria-label={status === 'working' ? 'Working' : status === 'input' ? 'Needs your input' : status === 'done' ? 'Finished' : status === 'error' ? 'Failed' : undefined}
          aria-hidden={status ? undefined : 'true'} className={cn('flex shrink-0 items-center justify-center', status ? 'mx-1.5 w-5' : 'w-1.5')}>
          {status === 'working' ? <Loader2Icon className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" /> : status ? <KindIcon kind={status === 'input' ? 'input' : status} className="size-[1.125rem]" /> : null}
        </span>
        <button ref={titleButton} type="button" data-testid="ambient-title" onClick={expand} disabled={expanded} aria-label={expanded ? shownTitle : `Open chat: ${shownTitle}`}
          className="min-w-0 max-w-full cursor-pointer truncate rounded-md px-1 py-1 text-left text-[0.9375rem] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default max-sm:py-2.5">{shownTitle}</button>
        {conversations && <button type="button" data-testid="ambient-switch" aria-label="Switch conversation" aria-haspopup="dialog" aria-expanded={picking} title="Switch conversation" onClick={() => setPicking(open => !open)}
          className={cn(iconButton, 'size-7 max-sm:size-11')}><ChevronDownIcon className="size-3.5" aria-hidden="true" /></button>}
        {expanded ? <span className="flex-1" /> : <button type="button" tabIndex={-1} aria-hidden="true" data-testid="ambient-header-fill" onClick={expand} className="h-full min-w-2 flex-1 cursor-pointer" />}
        {systemNotifications && permission === 'default' && <button type="button" data-testid="ambient-enable-notifications" aria-label="Notify me when the page is in the background" title="Notify me when the page is in the background"
          onClick={() => { void requestNotifyPermission().then(setPermission); }} className={iconButton}><BellIcon className="size-4" aria-hidden="true" /></button>}
        {onDock && !phone && <button type="button" data-testid="ambient-dock" aria-label="Dock chat" title="Dock chat beside the panel" onClick={() => { setPicking(false); onDock(); }} className={iconButton}><PanelLeftIcon className="size-4" aria-hidden="true" /></button>}
        {!phone && grip()}
      </header>

      {expanded && <div className="flex min-h-0 flex-1 flex-col">
        {(connectionKind === 'error' || connectionKind === 'closed') && <div className="px-4 pb-2"><Notice tone={connectionKind === 'error' ? 'error' : 'info'} testid="connection-notice">
          <span className="flex-1">{connectionKind === 'error' ? 'Conversation could not be loaded.' : 'Disconnected. Last observed messages remain visible.'}</span>
          {!state.disposed && <Button size="sm" variant="outline" onClick={() => act(controller.connect)}><RefreshCwIcon className="size-3.5" aria-hidden="true" />Reconnect</Button>}</Notice></div>}
        {derived.pinned.length > 0 && <aside aria-label="Required conversation actions" className="shrink-0 space-y-2 px-4 pb-2">{derived.pinned.map(card => <div key={card.key}>{card.content}</div>)}</aside>}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={stick.scrollRef} data-testid="transcript-scroll" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
            <div ref={stick.contentRef} role="log" aria-label="Messages" aria-live="polite" data-testid="transcript" className="flex min-h-28 flex-col gap-5 px-4 pt-1 pb-5">
              {hidden > 0 && <div className="flex justify-center"><Button size="sm" variant="outline" data-testid="show-earlier" className="rounded-full text-muted-foreground" onClick={transcript.reveal}>Show earlier messages</Button></div>}
              {visibleRows.map(row => <RowView key={row.key} row={row} context={rowContext} />)}
              {loading && <p role="status" data-testid="loading" className="m-0 flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Loading conversation…</p>}
              {empty && !loading && <p data-testid="ambient-empty" className="m-0 py-6 text-center text-sm text-muted-foreground">Ask the agent to do something.</p>}
            </div>
          </div>
          {!stick.isAtBottom && <Button variant="outline" size="icon" data-testid="jump-latest" aria-label="Jump to latest" title="Jump to latest" onClick={() => { transcript.reset(); void stick.scrollToBottom(); }}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/95 shadow-md backdrop-blur"><ArrowDownIcon className="size-4" aria-hidden="true" /></Button>}
        </div>
      </div>}

      <div className={cn('shrink-0', expanded && 'border-t border-border', phone && 'pb-[env(safe-area-inset-bottom)]')}>
        <div className="space-y-2 px-3 empty:hidden [&:has(*)]:pt-2">
          <ChatNotices state={state} error={error} onReconcile={() => act(controller.reconcile)} onRetry={() => act(controller.retrySameRequest)} />
          {!expanded && (connectionKind === 'error' || connectionKind === 'closed') && <Notice tone="info" testid="connection-notice">
            <span className="flex-1">{connectionKind === 'error' ? 'Could not load the conversation.' : 'Disconnected.'}</span>
            {!state.disposed && <Button size="sm" variant="outline" onClick={() => act(controller.connect)}>Reconnect</Button>}</Notice>}
        </div>
        <MessageQueue items={queued} withdraw={actions?.withdraw} actions={queueActions} />
        <Composer {...composer} layout="inline" placeholder={working || waitingForAnswer ? label : placeholder} barStart={barStart} barNote={barNote} barEnd={tools} />
      </div>
      </section>} />
    </div>
  </div>;
}
