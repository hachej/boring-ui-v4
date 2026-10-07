'use client';

import { lazy, Suspense, useRef, useState } from 'react';
import type { CanvasEditorProps } from './canvas-editor-native.js';

// The native module owns the editor's prop types; this wrapper only loads it lazily (type imports are erased, so the chunk stays split).
export type { CanvasAssetUrls, CanvasEditorProps, CanvasFontUrls } from './canvas-editor-native.js';

const NativeCanvas = lazy(() => import('./canvas-editor-native.js'));

/** Borrows one controller/store. The host supplies native CSS, fonts and any production license. */
export function CanvasEditor(props: CanvasEditorProps) {
  const active = useRef(props.controller);
  active.current = props.controller;
  const [mount, setMount] = useState({ controller: props.controller, sequence: 0 });
  if (mount.controller !== props.controller) setMount({ controller: props.controller, sequence: mount.sequence + 1 });
  return <Suspense fallback={<p role="status">Loading canvas</p>}>
    <NativeCanvas key={mount.sequence} {...props} activeController={active} />
  </Suspense>;
}
