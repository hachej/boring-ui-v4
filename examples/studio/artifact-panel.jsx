// The artifact panel: opens beside the chat when an artifact card is clicked, as in Claude's chat apps. The standard viewer bar (title, type,
// version switcher, Refresh, Share, copy, download, close) sits over the viewer for the artifact's type. The panel follows the
// latest saved revision while nothing is unsaved ("Latest") or pins one older version, read-only. It lists the versions its workspace
// provider retains for the file (`/api/history`) and reads through the same authenticated resource endpoint as the file viewer and the
// demo panels. It never executes artifact content.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CodeXmlIcon, EyeIcon } from 'lucide-react';
import { createResourceClient } from '@boring/files/remote';
import { createMarkdownController } from '@boring/ui/markdown';
import { createHtmlController } from '@boring/ui/html';
import { artifactKey, collectArtifacts } from '../../registry/pi-chat/pi-chat.tsx';
import { CodeBlock } from '../../registry/pi-chat/code-block.tsx';
import { typeLabel } from '../../registry/pi-chat/artifact.ts';
import { HtmlPane } from '../../registry/viewers/html-pane.tsx';
import { MarkdownPane } from '../../registry/viewers/markdown-pane.tsx';
import { ViewerFrame, ViewerToggle } from '../../registry/viewers/viewer-frame.tsx';
import { ViewerVersions } from '../../registry/viewers/menu.tsx';
import { INTERACTIVE_HTML } from './interactive.mjs';
import { downloadFile } from '../../registry/viewers/download.ts';
import { copyText } from '../../registry/utils/utils.ts';
import { shareStudioLink } from './share-link.mjs';
import { Canvas } from './panels/canvas.jsx';
import { savedLabel, useSaved } from './saved-resource.mjs';
import { randomUUID } from '@boring/files/platform';

const NOOP = () => () => {};
const POLL_MS = 1500;
const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;

/** Every artifact version the open conversation's tool results produced (the version switcher's source). */
export function useArtifactVersions(controller, detect) {
  const view = useSyncExternalStore(controller ? controller.subscribe : NOOP, () => controller?.getSnapshot().view, () => undefined);
  return useMemo(() => collectArtifacts(view, detect), [view, detect]);
}

/** How many messages the person has sent in the open conversation: it changes when a new turn starts. */
export function useTurn(controller) {
  const view = useSyncExternalStore(controller ? controller.subscribe : NOOP, () => controller?.getSnapshot().view, () => undefined);
  return useMemo(() => (view?.entries ?? []).reduce((count, entry) => count + (entry.model ?? []).filter(message => message.role === 'user').length, 0), [view]);
}

/** How many messages the person has typed in the open conversation (a background subagent's report is a user message too, but not typed). */
export function useTyped(controller) {
  const view = useSyncExternalStore(controller ? controller.subscribe : NOOP, () => controller?.getSnapshot().view, () => undefined);
  return useMemo(() => (view?.entries ?? []).reduce((count, entry) => count + (entry.model ?? []).filter(message => message.role === 'user'
    && !(typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').join('')).startsWith('[Background subagent #')).length, 0), [view]);
}

/** The revisions the workspace provider retains for a file with their save times, newest first; followed while the panel is open. */
function useHistory(api, path) {
  const [revisions, setRevisions] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const key = saves => saves.map(save => `${save.revision}@${save.savedAt}`).join();
    const load = () => api(`/api/history?path=${encodeURIComponent(path)}`).then(result => { if (!cancelled) setRevisions(current => key(current) === key(result.saves) ? current : result.saves); }).catch(() => {});
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, path]);
  return revisions;
}

/**
 * The version menu, newest first: each retained revision is named by when it was saved, and the newest is "Latest". The position of a
 * revision in the list is only a test hook (`number`, counted from the oldest retained); the pin is the revision.
 */
function versionMenu({ artifact, follow, revisions }) {
  const at = follow ? 0 : revisions.findIndex(save => save.revision === artifact.revision);
  const shown = at < 0 ? undefined : revisions[at];
  return { items: revisions.map((save, index) => ({ id: index === 0 ? 'latest' : save.revision, label: savedLabel(save.savedAt), latest: index === 0 })),
    current: follow ? 'latest' : artifact.revision, number: shown ? revisions.length - at : undefined, savedAt: shown?.savedAt, hasHistory: revisions.length > 0 };
}

function SvgView({ text, title, frame }) {
  const [mode, setMode] = useState('preview');
  // An SVG is shown only as an image from a blob URL: it never becomes markup in this page, so its scripts cannot run.
  const url = useMemo(() => URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' })), [text]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <ViewerFrame {...frame} controls={<>
    <ViewerToggle label="View" value={mode} onChange={setMode} options={[
      { id: 'preview', label: 'Preview', text: 'Preview', icon: <EyeIcon className="size-4" aria-hidden="true" />, testId: 'artifact-mode' },
      { id: 'source', label: 'Source', text: 'Source', icon: <CodeXmlIcon className="size-4" aria-hidden="true" />, testId: 'artifact-mode' }]} />
    {frame.controls}</>}>
    {mode === 'preview'
      ? <div className="boring-viewer-checker flex min-h-0 flex-1 items-center justify-center overflow-auto bg-white p-6"><img data-testid="artifact-svg" src={url} alt={title} className="max-h-full max-w-full" /></div>
      : <div className="min-h-0 flex-1 overflow-auto p-3"><CodeBlock code={text} language="svg" /></div>}
  </ViewerFrame>;
}

/** The frame props every artifact type shares: title, subtitle (type and version), the version switcher, Share and Close. */
function useFrame({ artifact, pinned, menu, onSelect, onClose, shareTarget, revision }) {
  // The history menu: newest first, the newest marked "Latest" (choosing it follows the latest), the one on display checked.
  const select = menu.items.length > 1 && <ViewerVersions testId="artifact-versions" current={menu.current} onSelect={onSelect} versions={menu.items} />;
  return {
    title: artifact.title, testId: 'artifact', titleTestId: 'artifact-panel-title', controls: select || undefined, onClose, onShare: shareStudioLink, revision,
    target: { ...shareTarget, artifact: artifactKey(artifact), version: pinned ? artifact.revision : 'latest' },
    subtitle: <>
      <span data-testid="artifact-panel-type">{typeLabel(artifact)}</span>
      <span aria-hidden="true">·</span>
      <span data-testid="artifact-panel-version">{pinned ? (menu.savedAt !== undefined ? `Saved ${savedLabel(menu.savedAt)}` : 'Older version') : menu.savedAt ? `Latest, saved ${savedLabel(menu.savedAt)}` : 'Latest'}</span>
    </>,
    ...(pinned ? { status: { label: 'Read-only' } } : {}),
  };
}

/** One artifact version's frame and body. Mounted per resource and revision, so switching version starts clean. */
function Version({ artifact, pinned, menu, client, identity, authorized, onSelect, onClose, shareTarget }) {
  const { type } = artifact;
  const path = artifact.target.resource.path;
  const create = useMemo(() => {
    const base = snapshot => ({ identity, client, instanceId: randomUUID(), epoch: 'studio', source: { kind: 'saved', snapshot } });
    if (type === 'markdown') return snapshot => createMarkdownController({ ...base(snapshot), readOnly: pinned });
    if (type === 'html') return snapshot => createHtmlController({ ...base(snapshot), readOnly: true });
    return undefined;
  }, [type, pinned, client, identity]);
  const saved = useSaved({ client, target: artifact.target, revision: pinned ? artifact.revision : undefined, create: type === 'canvas' ? undefined : create });
  const controller = saved.controller;
  // The text to copy and download is the buffer when a viewer holds one, so the person's unsaved edits are included.
  const text = useSyncExternalStore(controller ? controller.subscribe : NOOP, () => controller ? controller.getSnapshot().text : saved.text, () => saved.text);
  const extension = EXTENSION.exec(path)?.[1] ?? 'txt';
  const revision = saved.kind === 'open' ? saved.snapshot.ref.revision : pinned ? artifact.revision : undefined;
  const frame = useFrame({ artifact, pinned, menu, onSelect, onClose, shareTarget, revision });
  const filename = `${artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact'}.${extension}`;
  const body = children => <div data-testid="artifact-body" data-state={saved.kind} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">{children}</div>;
  if (type === 'canvas') return body(<Canvas panel={{ target: artifact.target, title: artifact.title, ...(pinned ? { revision: artifact.revision } : {}) }} authorized={authorized} identity={identity}
    frame={{ testId: 'artifact', titleTestId: 'artifact-panel-title', controls: frame.controls, onClose, target: frame.target }} />);
  if (saved.kind !== 'open') {
    return body(<ViewerFrame {...frame}><p className="m-0 p-4 text-sm text-muted-foreground" role="status">{saved.kind === 'loading' ? 'Loading…' : saved.kind === 'invalid' ? 'This artifact cannot be shown as text.' : 'This version is not available.'}</p></ViewerFrame>);
  }
  const document = children => <div data-testid="document" data-revision={saved.snapshot.ref.revision} className="h-full min-h-0">{children}</div>;
  if (type === 'markdown') return body(document(<MarkdownPane controller={controller} initialMode="rich" {...frame} />));
  if (type === 'html') return body(document(<HtmlPane controller={controller} interactive={INTERACTIVE_HTML} {...frame} />));
  const actions = { onCopy: () => copyText(text ?? ''), onDownload: () => downloadFile(filename, text ?? '', `${artifact.mediaType};charset=utf-8`) };
  if (type === 'svg') return body(<SvgView text={saved.text} title={artifact.title} frame={{ ...frame, ...actions }} />);
  return body(<ViewerFrame {...frame} {...actions}><div className="min-h-0 flex-1 overflow-auto p-3"><CodeBlock code={saved.text} language={artifact.language ?? 'text'} /></div></ViewerFrame>);
}

/**
 * `active`: { descriptor, follow }. `versions`: every version of this file presented or saved in the conversation, newest first (the newest names the title). Follow shows the latest
 * saved revision under the newest known title; otherwise the one version in `descriptor` is pinned and read-only.
 */
/** `shareTarget`: the link fields that identify the demo and conversation this panel belongs to, for Share. */
export function ArtifactPanel({ active, versions, api, authorized, identity, onSelect, onClose, shareTarget }) {
  const { follow } = active;
  const artifact = follow ? versions[0] ?? active.descriptor : active.descriptor;
  const path = artifact.target.resource.path;
  const [client] = useState(() => createResourceClient({ identity, endpoint: new URL('/api/resources', location.href), publication: true, reconciliation: true, fetch: authorized }));
  const revisions = useHistory(api, path);
  const menu = versionMenu({ artifact, follow, revisions });
  return <div data-testid="artifact-panel" data-artifact-id={artifactKey(artifact)} data-artifact-type={artifact.type} data-follow={follow ? 'true' : 'false'} data-artifact-position={menu.number} data-artifact-revision={follow ? undefined : artifact.revision}
    className="pi-chat flex h-full min-h-0 flex-col">
    <Version key={`${path}@${follow ? 'latest' : artifact.revision}`} artifact={artifact} pinned={!follow} menu={menu} client={client} identity={identity} authorized={authorized}
      onSelect={onSelect} onClose={onClose} shareTarget={shareTarget} />
  </div>;
}
