'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { CodeXmlIcon, EyeIcon, RotateCcwIcon, SaveIcon, SearchCheckIcon } from 'lucide-react';
import { HtmlViewer } from '@boring/ui/html-viewer';
import type { HtmlController } from '@boring/ui/html';
import { IconButton } from './button';
import { downloadFile, fileNameFor } from './download';
import { copyText } from './utils';
import { InteractiveFrame } from './interactive-html';
import type { InteractiveHtml } from './interactive-html';
import { ViewerFrame, ViewerToggle } from './viewer-frame';
import type { ViewerShare, ViewerStatus } from './viewer-frame';

export type HtmlPaneMode = 'preview' | 'source';

export interface HtmlPaneProps {
  /** Borrowed: the host owns the controller and disposes it. */
  readonly controller: HtmlController;
  readonly title?: string;
  readonly subtitle?: ReactNode;
  readonly target?: unknown;
  readonly revision?: string;
  readonly initialMode?: HtmlPaneMode;
  /** Reports the person's choice, so a host that remounts the pane (for a new revision) can start it in the same mode. */
  readonly onModeChange?: (mode: HtmlPaneMode) => void;
  /**
   * Host opt-in (off by default): the preview then runs the page's own scripts in a sandboxed frame with an opaque origin and a
   * Content-Security-Policy limited to inline code and `scriptSources`. See registry/README.md. Without it the preview is the passive,
   * script-free rendering of `@boring/ui/html-viewer`.
   */
  readonly interactive?: InteractiveHtml;
  readonly controls?: ReactNode;
  readonly onRefresh?: () => unknown;
  readonly onShare?: ViewerShare;
  readonly onOpenInNewTab?: () => unknown;
  readonly onClose?: () => unknown;
  readonly testId?: string;
  /** Overrides the title's `data-testid` (default `<testId>-title`). */
  readonly titleTestId?: string;
  readonly className?: string;
}

export function htmlStatus(state: ReturnType<HtmlController['getSnapshot']>): ViewerStatus {
  if (state.lifecycle === 'disposed') return { label: 'Closed' };
  if (state.save.kind === 'pending') return { label: 'Saving' };
  if (state.save.kind === 'settled' && state.save.result.kind === 'unknown') return { label: 'Save unconfirmed', tone: 'warning' };
  if (state.remote !== null || state.save.kind === 'settled' && state.save.result.kind === 'conflict') return { label: 'Changed elsewhere', tone: 'warning' };
  if (state.readOnly) return { label: 'Read-only' };
  return state.dirty ? { label: 'Unsaved', tone: 'warning' } : { label: 'Saved', tone: 'success' };
}

/** The HTML safe preview and source editor in the standard viewer frame. The preview never runs scripts; a host-enabled interactive preview runs them, in a sandbox. */
export function HtmlPane({ controller, title = 'HTML document', subtitle, target, revision, initialMode = 'preview', onModeChange, interactive, controls, onRefresh, onShare, onOpenInNewTab, onClose, testId = 'viewer', titleTestId, className }: HtmlPaneProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [mode, setModeState] = useState<HtmlPaneMode>(initialMode);
  const setMode = (next: HtmlPaneMode) => { setModeState(next); onModeChange?.(next); };
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string>();
  const pending = state.save.kind === 'pending';
  const unconfirmed = state.save.kind === 'settled' && state.save.result.kind === 'unknown';
  const disposed = state.lifecycle === 'disposed';
  const perform = (action: () => Promise<{ readonly kind: string; readonly reason?: string }>) => {
    setError(undefined);
    void Promise.resolve().then(action).then(result => { if ((result.kind === 'denied' || result.kind === 'unavailable') && result.reason) setError(result.reason); })
      .catch(() => setError('The document operation failed. Your source has been retained.'));
  };
  const filename = useMemo(() => fileNameFor(title, 'html'), [title]);
  return <ViewerFrame title={title} subtitle={subtitle} status={htmlStatus(state)} target={target} revision={revision} testId={testId} {...(titleTestId ? { titleTestId } : {})} className={className}
    onRefresh={() => { if (interactive && mode === 'preview') setReload(count => count + 1); return (onRefresh ?? (() => controller.actions.refresh()))(); }} onShare={onShare} onCopy={() => copyText(controller.getSnapshot().text)}
    onDownload={() => downloadFile(filename, controller.getSnapshot().text, 'text/html;charset=utf-8')} onOpenInNewTab={onOpenInNewTab} onClose={onClose}
    controls={<>
      <ViewerToggle label="View" value={mode} onChange={setMode} options={[
        { id: 'preview', label: 'HTML preview', text: 'Preview', icon: <EyeIcon className="size-4" aria-hidden="true" />, testId: `${testId}-mode-preview` },
        { id: 'source', label: 'HTML source', text: 'Source', icon: <CodeXmlIcon className="size-4" aria-hidden="true" />, testId: `${testId}-mode-source` }]} />
      {!state.readOnly && state.dirty && <IconButton label="Save" variant="default" data-testid={`${testId}-save`} disabled={disposed || pending || unconfirmed} onClick={() => perform(() => controller.flush(controller.actions.selection()))}><SaveIcon className="size-4" aria-hidden="true" /></IconButton>}
      {unconfirmed && <IconButton label="Check save outcome" onClick={() => perform(controller.actions.reconcile)}><SearchCheckIcon className="size-4" aria-hidden="true" /></IconButton>}
      {unconfirmed && <IconButton label="Abandon and refresh, keeping my draft" onClick={() => perform(controller.actions.abandon)}><RotateCcwIcon className="size-4" aria-hidden="true" /></IconButton>}
      {state.remote !== null && <IconButton label="Discard local edits" disabled={pending || unconfirmed} onClick={() => perform(controller.actions.discardToRemote)}><RotateCcwIcon className="size-4" aria-hidden="true" /></IconButton>}
      {controls}
    </>}>
    {error && <p role="alert" className="m-0 border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
    {interactive && mode === 'preview'
      ? <InteractiveFrame text={state.text} sources={interactive.scriptSources} reload={reload} title={`${title} (running)`} testId={testId} />
      : <HtmlViewer controller={controller} title={title} header={false} mode={mode === 'source' ? 'source' : 'preview'} onModeChange={next => setMode(next)} className="boring-html-pane" />}
  </ViewerFrame>;
}
