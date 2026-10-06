import { loadSnapshot } from '@tldraw/editor';
import type { TLRecord, TLStore, TLStoreSnapshot } from '@tldraw/editor';
import { Store } from '@tldraw/store';
import type { ResourceAccess, ResourceClient, ResourceLocator, ResourceSnapshot } from '@boring/files';
import type { SaveSelection } from './resources.js';
import { createTextBuffer, freeze, type TextBufferState } from './text-buffer.js';

export const canvasMediaType = 'application/vnd.tldraw+json';
export type CanvasSource = { readonly kind: 'saved'; readonly snapshot: ResourceSnapshot }
  | { readonly kind: 'new'; readonly target: ResourceLocator };
export interface CanvasOptions {
  /** Borrow one editor's store; the host owns its lifetime and native schema. */
  readonly store: TLStore;
  readonly source: CanvasSource;
  readonly client: ResourceClient;
  readonly identity: Pick<ResourceAccess, 'scopeId' | 'principalId' | 'initiatorId'>;
  readonly instanceId: string;
  readonly epoch: string;
  readonly readOnly?: boolean;
  readonly onListenerError?: (error: unknown) => void;
}
export type CanvasState = Omit<TextBufferState, 'text'> & { readonly document: TLStoreSnapshot; readonly problem: string | null };
const shapeTypes = new Set(['arrow', 'draw', 'frame', 'geo', 'group', 'highlight', 'line', 'note', 'text']);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function allowed(record: TLRecord): void {
  if (record.typeName === 'asset') throw new TypeError('Canvas assets require a separately qualified asset adapter');
  if (record.typeName === 'shape' && !shapeTypes.has(record.type)) throw new TypeError('Unsupported canvas shape');
  if (record.typeName === 'binding' && record.type !== 'arrow') throw new TypeError('Unsupported canvas binding');
  if (record.typeName === 'user' && record.imageUrl !== '') throw new TypeError('Canvas author images require a separately qualified asset adapter');
  if (!['document', 'page', 'shape', 'binding', 'user'].includes(record.typeName)) throw new TypeError('Only canvas document records may be published');
}
function documentFrom(value: unknown, owner: TLStore): TLStoreSnapshot {
  if (!object(value) || Object.keys(value).some(key => key !== 'schema' && key !== 'store') || !object(value['schema']) || !object(value['store'])) throw new TypeError('Expected a canvas document snapshot');
  const schema = owner.schema.serialize(), supplied = value['schema'], sequences = supplied['sequences'];
  if (supplied['schemaVersion'] !== schema.schemaVersion || !object(sequences)
    || Object.keys(sequences).length !== Object.keys(schema.sequences).length
    || Object.entries(schema.sequences).some(([key, version]) => sequences[key] !== version)) throw new TypeError('Canvas schema migration is not qualified');
  const records: TLRecord[] = [];
  for (const [id, item] of Object.entries(value['store'])) {
    if (!object(item)) throw new TypeError('Invalid canvas record');
    const type = Object.values(owner.schema.types).find(candidate => candidate.typeName === item['typeName']);
    if (!type || type.scope !== 'document') throw new TypeError('Canvas snapshots cannot contain unknown or session records');
    const record = type.validate(item);
    if (record.id !== id) throw new TypeError('Canvas record key and identity differ');
    allowed(record); records.push(record);
  }
  const scratch = new Store({ schema: owner.schema, props: owner.props });
  try {
    scratch.loadStoreSnapshot({ schema, store: Object.fromEntries(records.map(record => [record.id, record])) });
    const document = scratch.getStoreSnapshot('document');
    for (const record of Object.values(document.store)) allowed(record);
    return structuredClone(document);
  } finally { scratch.dispose(); }
}

/** Revision-checked document publication over a borrowed native tldraw store. */
export function createCanvasController(options: CanvasOptions) {
  const { store } = options;
  let loading = false, disposed = false;
  let problem: string | null = null;
  const readText = (snapshot: ResourceSnapshot): string => {
    if (snapshot.mediaType !== canvasMediaType) throw new TypeError('Expected a tldraw document media type');
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes));
    return JSON.stringify(documentFrom(input, store));
  };
  const emptyText = JSON.stringify(documentFrom({ schema: store.schema.serialize(), store: {} }, store));
  const initialText = options.source.kind === 'saved' ? readText(options.source.snapshot)
    : JSON.stringify(documentFrom(store.getStoreSnapshot('document'), store));
  const existing = store.getStoreSnapshot('document');
  if (options.source.kind === 'saved' && Object.keys(existing.store).length > 0
    && JSON.stringify(documentFrom(existing, store)) !== initialText) throw new Error('Borrowed canvas store differs from the saved source; select an empty store or explicitly discard before mounting');
  let captured = initialText;
  const replaceText = (text: string): void => {
    const input: unknown = JSON.parse(text);
    const document = documentFrom(input, store);
    loading = true;
    try { loadSnapshot(store, { document }); captured = JSON.stringify(store.getStoreSnapshot('document')); problem = null; }
    finally { loading = false; }
  };
  const buffer = createTextBuffer({ ...options, source: options.source.kind === 'new' ? { ...options.source, text: initialText } : options.source,
    mediaType: canvasMediaType, emptyText, readText, replaceText, sync: () => capture() });
  replaceText(initialText);
  function snapshot(): CanvasState {
    const { text: _text, ...state } = buffer.getSnapshot();
    return freeze({ ...state, document: structuredClone(store.getStoreSnapshot('document')), problem });
  }
  let state = snapshot();
  const listeners = new Set<() => void>();
  const notify = () => {
    state = snapshot();
    for (const listener of [...listeners]) {
      try { listener(); }
      catch (error) { queueMicrotask(() => { if (options.onListenerError) options.onListenerError(error); else throw error; }); }
    }
  };
  const unsubscribe = buffer.subscribe(notify);
  const capture = (): void => {
    if (disposed || loading) return;
    const document = store.getStoreSnapshot('document'), text = JSON.stringify(document);
    if (text === captured) return;
    try { documentFrom(document, store); problem = null; }
    catch (error) { problem = error instanceof Error ? error.message : 'Canvas document is invalid'; }
    captured = text;
    buffer.observe(text);
  };
  const cleanup = Object.values(store.schema.types).filter(type => type.scope === 'document').flatMap(type => [
    store.sideEffects.registerAfterCreateHandler(type.typeName, capture),
    store.sideEffects.registerAfterChangeHandler(type.typeName, capture),
    store.sideEffects.registerAfterDeleteHandler(type.typeName, capture),
  ]);
  cleanup.push(store.listen(capture, { scope: 'document', source: 'all' }));
  return {
    store,
    getSnapshot: (): CanvasState => state,
    subscribe: (listener: () => void): (() => void) => { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    actions: {
      selection: (): SaveSelection => { capture(); if (problem) throw new Error(problem); return buffer.selection(); },
      refresh: () => { capture(); return buffer.refresh(false); },
      discardToRemote: () => { capture(); return buffer.refresh(true); },
      reconcile: buffer.reconcile,
    },
    flush: (selection: SaveSelection, signal?: AbortSignal) => {
      capture();
      return problem ? Promise.resolve({ kind: 'denied' as const, reason: problem }) : buffer.flush(selection, signal);
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      for (const remove of cleanup) remove();
      buffer.dispose(); unsubscribe(); listeners.clear();
    },
  };
}
export type CanvasController = ReturnType<typeof createCanvasController>;
