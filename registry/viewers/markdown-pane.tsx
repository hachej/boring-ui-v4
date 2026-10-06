'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { CodeXmlIcon, PencilLineIcon, SaveIcon } from 'lucide-react';
import { MarkdownEditor } from '@boring/ui/markdown-editor';
import type { MarkdownImageResolver, MarkdownMountedTools, MarkdownRichSafety } from '@boring/ui/markdown-editor';
import type { MarkdownController } from '@boring/ui/markdown';
import { IconButton } from '../button/button';
import { downloadFile, fileNameFor } from './download';
import { copyText } from '../utils/utils';
import { ViewerFrame, ViewerToggle } from './viewer-frame';
import type { ViewerShare, ViewerStatus } from './viewer-frame';

export interface MarkdownPaneProps {
  /** Borrowed: the host owns the controller and disposes it. */
  readonly controller: MarkdownController;
  readonly title?: string;
  readonly subtitle?: ReactNode;
  readonly target?: unknown;
  readonly revision?: string;
  readonly initialMode?: 'rich' | 'source';
  /** Reports the person's choice, so a host that remounts the pane (for a new revision) can start it in the same mode. */
  readonly onModeChange?: (mode: 'rich' | 'source') => void;
  readonly placeholder?: string;
  /** Extra viewer controls, for example a version switcher. */
  readonly controls?: ReactNode;
  /** Defaults to the controller's refresh: a clean document follows the saved one, unsaved edits are kept and shown as changed elsewhere. */
  readonly onRefresh?: () => unknown;
  readonly onShare?: ViewerShare;
  readonly onOpenInNewTab?: () => unknown;
  readonly onClose?: () => unknown;
  /** Host mapping from an image address in the document to a loadable URL. Images stay inert without it. */
  readonly resolveImage?: MarkdownImageResolver;
  readonly onMountedTools?: (tools: MarkdownMountedTools | null) => void;
  readonly testId?: string;
  /** Overrides the title's `data-testid` (default `<testId>-title`). */
  readonly titleTestId?: string;
  readonly className?: string;
}

/** The status chip for a Markdown controller: Saved, Unsaved, Saving, Changed elsewhere, Read-only. */
export function markdownStatus(state: ReturnType<MarkdownController['getSnapshot']>): ViewerStatus {
  if (state.lifecycle === 'disposed') return { label: 'Closed' };
  if (state.save.kind === 'pending') return { label: 'Saving' };
  if (state.save.kind === 'settled' && state.save.result.kind === 'unknown') return { label: 'Save unconfirmed', tone: 'warning' };
  if (state.save.kind === 'settled' && state.save.result.kind === 'conflict' || state.remote !== null) return { label: 'Changed elsewhere', tone: 'warning' };
  if (state.readOnly) return { label: 'Read-only' };
  return state.dirty ? { label: 'Unsaved', tone: 'warning' } : { label: 'Saved', tone: 'success' };
}

/** The Markdown editor in the standard viewer frame: mode toggle, Save while there are edits, Share, and Reload, Copy and Download under the "…" menu. */
export function MarkdownPane({ controller, title = 'Document', subtitle, target, revision, initialMode = 'rich', onModeChange, placeholder, controls, onRefresh, onShare, onOpenInNewTab, onClose, resolveImage, onMountedTools, testId = 'viewer', titleTestId, className }: MarkdownPaneProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [requested, setRequestedState] = useState<'rich' | 'source'>(initialMode);
  const setRequested = (next: 'rich' | 'source') => { setRequestedState(next); onModeChange?.(next); };
  const [safety, setSafety] = useState<MarkdownRichSafety>({ safe: true });
  const mode = safety.safe ? requested : 'source';
  const unavailable = state.readOnly || state.lifecycle !== 'active';
  const pending = state.save.kind === 'pending';
  const unconfirmed = state.save.kind === 'settled' && state.save.result.kind === 'unknown';
  const [refused, setRefused] = useState<{ readonly version: number; readonly label: string } | null>(null);
  const save = () => {
    setRefused(null);
    const version = controller.getSnapshot().bufferVersion;
    void controller.flush(controller.actions.selection()).then(result => {
      if (result.kind === 'denied' || result.kind === 'conflict' || result.kind === 'unavailable') {
        const reason = result.reason ?? (result.kind === 'conflict' ? 'changed elsewhere' : result.kind);
        setRefused({ version, label: `Not saved: ${reason.length > 48 ? `${reason.slice(0, 47)}…` : reason}` });
      }
    }, () => setRefused({ version, label: 'Not saved: the save failed' }));
  };
  const filename = useMemo(() => fileNameFor(title, 'md'), [title]);
  return <ViewerFrame title={title} subtitle={subtitle} status={refused && refused.version === state.bufferVersion && state.save.kind !== 'pending' ? { label: refused.label, tone: 'warning' } : markdownStatus(state)} target={target} revision={revision} testId={testId} {...(titleTestId ? { titleTestId } : {})} className={className}
    onRefresh={onRefresh ?? (() => controller.actions.refresh())} onShare={onShare} onCopy={() => copyText(controller.getSnapshot().text)}
    onDownload={() => downloadFile(filename, controller.getSnapshot().text, 'text/markdown;charset=utf-8')} onOpenInNewTab={onOpenInNewTab} onClose={onClose}
    controls={<>
      <ViewerToggle label="Editor mode" value={mode} onChange={setRequested} options={[
        { id: 'rich', label: 'Rich text', text: 'Rich', icon: <PencilLineIcon className="size-4" aria-hidden="true" />, disabled: !safety.safe, testId: `${testId}-mode-rich` },
        { id: 'source', label: 'Markdown source', text: 'Source', icon: <CodeXmlIcon className="size-4" aria-hidden="true" />, testId: `${testId}-mode-source` }]} />
      {!state.readOnly && state.dirty && <IconButton label="Save" variant="default" data-testid={`${testId}-save`} disabled={unavailable || pending || unconfirmed} onClick={save}><SaveIcon className="size-4" aria-hidden="true" /></IconButton>}
      {controls}
    </>}>
    <MarkdownEditor controller={controller} title={title} header={false} mode={mode} onModeChange={setRequested} onRichSafety={setSafety}
      {...(placeholder === undefined ? {} : { placeholder })} {...(resolveImage ? { resolveImage } : {})} {...(onMountedTools ? { onMountedTools } : {})} className="boring-markdown-editor" />
  </ViewerFrame>;
}
