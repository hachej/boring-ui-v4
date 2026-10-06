// Opens one workspace file in the viewer that suits its type, always in the standard viewer frame (registry/viewers):
// Markdown and HTML in their editors (revisioned through the workspace resource adapter, so saves go back to the file and an
// edit made behind the editor's back is a conflict), images and PDFs read-only from the file's bytes, anything else as text.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon } from 'lucide-react';
import { createResourceClient } from '@boring/files/remote';
import { createMarkdownController } from '@boring/ui/markdown';
import { createHtmlController } from '@boring/ui/html';
import { HtmlPane } from '../../registry/viewers/html-pane.tsx';
import { ImagePane } from '../../registry/viewers/image-pane.tsx';
import { MarkdownPane } from '../../registry/viewers/markdown-pane.tsx';
import { PdfPane } from '../../registry/viewers/pdf-pane.tsx';
import { ViewerFrame } from '../../registry/viewers/viewer-frame.tsx';
import { downloadFile } from '../../registry/viewers/download.ts';
import { Canvas } from './panels/canvas.jsx';
import { formatBytes } from '../../registry/viewers/media.ts';
import { copyText } from '../../registry/viewers/utils.ts';
import { kindOf, mediaTypeOf } from './file-types.mjs';
import { shareStudioLink } from './share-link.mjs';
import { INTERACTIVE_HTML } from './interactive.mjs';
import { useSaved } from './saved-resource.mjs';
import { randomUUID } from '@boring/files/platform';

const POLL_MS = 1500;
const relative = path => path.replace(/^\/workspace\//, '');
const nameOf = path => path.split('/').pop() || path;
const TYPE_LABEL = { markdown: 'Markdown', html: 'HTML', canvas: 'Canvas', image: 'Image', pdf: 'PDF', text: 'Text' };

const subtitleOf = path => <><span data-testid="file-path" className="truncate">{relative(path)}</span></>;

/** Markdown or HTML: a revisioned controller over the workspace file. */
function WorkspaceDocument({ path, kind, target, share, identity, authorized, onClose, back }) {
  const [client] = useState(() => createResourceClient({ identity, endpoint: new URL('/api/resources', location.href), publication: true, reconciliation: true, fetch: authorized }));
  const resource = useMemo(() => ({ resource: { providerId: 'workspace', path: relative(path) }, view: { kind: 'published' } }), [path]);
  const create = useMemo(() => snapshot => (kind === 'markdown' ? createMarkdownController : createHtmlController)({
    identity, client, instanceId: randomUUID(), epoch: 'studio', source: { kind: 'saved', snapshot } }), [kind, client, identity]);
  const saved = useSaved({ client, target: resource, revision: undefined, create });
  // A new revision remounts the pane; it starts in the mode the person chose.
  const [mode, setMode] = useState(kind === 'markdown' ? 'rich' : 'preview');
  const common = { title: nameOf(path), subtitle: subtitleOf(path), target, onShare: share, onClose, titleTestId: 'file-title', controls: back };
  if (saved.kind !== 'open') {
    return <ViewerFrame title={nameOf(path)} subtitle={subtitleOf(path)} onClose={onClose} controls={back}>
      <p role="status" className="m-0 p-4 text-sm text-muted-foreground">{saved.kind === 'loading' ? 'Loading…' : saved.kind === 'missing' ? 'This file no longer exists.' : 'This file cannot be shown as text.'}</p>
    </ViewerFrame>;
  }
  // The preview selector the journeys use keeps working: the wrapper holds the document's text.
  return <div data-testid="file-preview" className="h-full min-h-0" data-revision={saved.snapshot.ref.revision}>
    {kind === 'markdown'
      ? <MarkdownPane key={saved.snapshot.ref.revision} controller={saved.controller} revision={saved.snapshot.ref.revision} initialMode={mode} onModeChange={setMode} {...common} />
      : <HtmlPane key={saved.snapshot.ref.revision} controller={saved.controller} revision={saved.snapshot.ref.revision} initialMode={mode} onModeChange={setMode} interactive={INTERACTIVE_HTML} {...common} />}
  </div>;
}

/** Image, PDF and text files: read through `/api/file`, refreshed on demand (and followed while open, for text). */
function WorkspaceFile({ path, kind, target, share, api, authorized, onClose, back }) {
  const [file, setFile] = useState({ kind: 'loading' });
  const held = useRef(file);
  held.current = file;
  const load = useCallback(async () => {
    const meta = await api(`/api/file?path=${encodeURIComponent(path)}`);
    let bytes;
    if (kind === 'image' || kind === 'pdf') {
      const response = await authorized(new Request(new URL(`/api/file?path=${encodeURIComponent(path)}&raw=1`, location.href)));
      if (!response.ok) throw new Error(`File: ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    setFile(current => current.kind === 'ready' && current.meta.size === meta.size && current.meta.text === meta.text && !bytes ? current : { kind: 'ready', meta, ...(bytes ? { bytes } : {}) });
  }, [api, authorized, path, kind]);
  useEffect(() => {
    let cancelled = false;
    const run = () => load().catch(() => { if (!cancelled && held.current.kind === 'loading') setFile({ kind: 'missing' }); });
    run();
    // Text follows the workspace while open; media is read again when the person presses Refresh.
    const timer = kind === 'text' ? setInterval(run, POLL_MS) : undefined;
    return () => { cancelled = true; clearInterval(timer); };
  }, [load, kind]);
  const common = { subtitle: subtitleOf(path), target, onShare: share, onClose, titleTestId: 'file-title', controls: back };
  if (file.kind !== 'ready') {
    return <ViewerFrame title={nameOf(path)} {...common}>
      <p role="status" className="m-0 p-4 text-sm text-muted-foreground">{file.kind === 'loading' ? 'Loading…' : 'This file no longer exists.'}</p>
    </ViewerFrame>;
  }
  if (kind === 'image') return <ImagePane name={nameOf(path)} mediaType={mediaTypeOf(path)} bytes={file.bytes} onRefresh={load} {...common} />;
  if (kind === 'pdf') return <PdfPane name={nameOf(path)} bytes={file.bytes} onRefresh={load} {...common} />;
  const { text, size } = file.meta;
  return <ViewerFrame title={nameOf(path)} {...common} subtitle={<>{subtitleOf(path)}<span aria-hidden="true">·</span><span>{formatBytes(size)}</span></>}
    onRefresh={load} onCopy={text === undefined ? undefined : () => copyText(text)} onDownload={text === undefined ? undefined : () => downloadFile(nameOf(path), text, 'text/plain;charset=utf-8')}>
    {text === undefined
      ? <p role="status" className="m-0 p-4 text-sm text-muted-foreground">This is a binary file ({formatBytes(size)}); it cannot be shown as text.</p>
      : <div className="min-h-0 flex-1 overflow-auto p-3"><pre data-testid="file-preview" className="m-0 whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-[13px] leading-relaxed">{text}</pre></div>}
  </ViewerFrame>;
}

/** `path` is the workspace path (`/workspace/...`). Remounted per file by the caller's `key`. */
export function FileViewer({ path, agentId, api, authorized, identity, onClose, onBack, backLabel }) {
  const kind = kindOf(path);
  const target = { variant: agentId, file: path };
  // From a demo's file list, a way back to it sits in the bar.
  const back = onBack ? <button type="button" data-testid="file-back" onClick={onBack} className="inline-flex h-10 cursor-pointer items-center gap-1 rounded-lg border border-border bg-background px-2 text-sm md:h-8 md:text-xs"><ArrowLeftIcon className="size-3.5" aria-hidden="true" />{backLabel ?? 'Back'}</button> : undefined;
  return <div data-testid="file-viewer" data-kind={kind} data-path={path} aria-label={`${TYPE_LABEL[kind]} viewer`} className="studio-viewer">
    {kind === 'markdown' || kind === 'html'
      ? <WorkspaceDocument path={path} kind={kind} target={target} share={shareStudioLink} identity={identity} authorized={authorized} onClose={onClose} back={back} />
      : kind === 'canvas'
        ? <Canvas panel={{ target: { resource: { providerId: 'workspace', path: relative(path) }, view: { kind: 'published' } }, title: nameOf(path) }} authorized={authorized} identity={identity}
            frame={{ titleTestId: 'file-title', onClose, target, controls: back }} />
        : <WorkspaceFile path={path} kind={kind} target={target} share={shareStudioLink} api={api} authorized={authorized} onClose={onClose} back={back} />}
  </div>;
}
