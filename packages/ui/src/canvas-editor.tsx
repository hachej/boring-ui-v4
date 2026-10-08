'use client';

import { lazy, Suspense, useState } from 'react';
export type { CanvasMountedSubject, CanvasMountedInspection, CanvasMountedTools } from './canvas-mounted.js';
import type { CanvasEditorProps } from './canvas-editor-native.js';

export type { CanvasAssetUrls, CanvasEditorProps, CanvasFontUrls } from './canvas-editor-native.js';

const NativeCanvas = lazy(() => import('./canvas-editor-native.js'));

/** Borrows one controller/store. The host supplies native CSS, fonts and any production license. */
export function CanvasEditor(props: CanvasEditorProps) {
  const [mount, setMount] = useState({ controller: props.controller, sequence: 0 });
  if (mount.controller !== props.controller) setMount({ controller: props.controller, sequence: mount.sequence + 1 });
  return <Suspense fallback={<p role="status">Loading canvas</p>}>
    <NativeCanvas key={mount.sequence} {...props} />
  </Suspense>;
}
