import { useEffect, useRef, useState } from 'react';

const POLL_MS = 1500;
const readText = bytes => { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; } };

/**
 * The saved text of one resource: the latest revision (polled while the local buffer is clean, never replacing unsaved
 * edits) or one exact revision read once. `create` may return a viewer controller for each saved snapshot.
 */
export function useSaved({ client, target, revision, create }) {
  const [state, setState] = useState({ kind: 'loading' });
  const held = useRef(state);
  held.current = state;
  useEffect(() => {
    let cancelled = false, reading = false;
    const follow = async () => {
      if (cancelled || reading) return;
      const now = held.current;
      const before = now.kind === 'open' ? now.controller?.getSnapshot() : undefined;
      if (before && (before.dirty || before.save?.kind === 'pending')) return;
      reading = true;
      let read;
      try { read = await client.read({ target, revision: revision ? { kind: 'exact', value: revision } : { kind: 'latest' } }).catch(() => undefined); }
      finally { reading = false; }
      if (cancelled || !read || held.current !== now) return;
      const local = now.kind === 'open' ? now.controller?.getSnapshot() : undefined;
      if (local !== before) return;
      if (read.kind !== 'available') { if (now.kind !== 'open') setState({ kind: read.kind }); return; }
      if (now.kind === 'open') {
        if (now.snapshot.ref.revision === read.snapshot.ref.revision) return;
        if (local && local.base?.kind === 'revision' && local.base.target.revision === read.snapshot.ref.revision) return;
        now.controller?.dispose();
      }
      const text = readText(read.snapshot.bytes);
      if (text === undefined) { setState({ kind: 'invalid' }); return; }
      let controller;
      try { controller = create?.(read.snapshot); } catch { setState({ kind: 'invalid' }); return; }
      held.current = { kind: 'open', snapshot: read.snapshot, text, controller };
      setState(held.current);
    };
    follow();
    const timer = revision ? undefined : setInterval(follow, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); held.current.controller?.dispose(); };
  }, [client, target.resource.path, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// Cards for the canvas the agent changes through the canvas tools (`present` carries its own descriptor; Pi's file tools make no card).
// The board is a file at its path: a saved change maps to a descriptor of that file at the revision the save produced, like a presented file.
const documentTools = variant => [
  ...(variant.capabilities.includes('canvas') ? [{ tools: ['add_canvas_shapes', 'remove_canvas_shapes'], type: 'canvas', mediaType: 'application/vnd.tldraw+json', target: variant.canvas }] : []),
];
export function savedResource(variant) {
  const specs = documentTools(variant);
  const revisionOf = result => {
    if (result.isError) return undefined;
    try {
      const value = JSON.parse(result.content.map(part => part.type === 'text' ? part.text : '').join(''));
      return value?.kind === 'saved' ? value.revision : undefined;
    } catch { return undefined; }
  };
  return (call, result) => {
    const spec = specs.find(candidate => candidate.tools.includes(call.name));
    const revision = spec && revisionOf(result);
    const path = spec?.target.resource.path;
    return revision ? { schema: 'boring.artifact', version: 1, title: path.slice(path.lastIndexOf('/') + 1), type: spec.type, mediaType: spec.mediaType, target: spec.target, revision } : undefined;
  };
}

/** A save time for a person: the clock time (with seconds, so two quick saves differ) today, the date as well on another day. */
export function savedLabel(savedAt, now = Date.now()) {
  if (!savedAt) return 'Earlier version';
  const day = value => new Date(value).toDateString();
  return new Date(savedAt).toLocaleString([], day(savedAt) === day(now) ? { timeStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'medium' });
}
