'use client';

import { lazy, Suspense, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { TLOnMountHandler } from '@tldraw/editor';
import type { TLDefaultFonts, TLUiAssetUrls } from 'tldraw';
import type { CanvasController } from './canvas.js';

export type CanvasFontUrls = Readonly<Record<`${keyof TLDefaultFonts}${'' | '_italic' | '_bold' | '_italic_bold'}`, string>>;
export type CanvasAssetUrls = Omit<TLUiAssetUrls, 'fonts' | 'embedIcons'> & {
  readonly fonts: CanvasFontUrls;
  readonly embedIcons: Required<TLUiAssetUrls['embedIcons']>;
};
export interface CanvasEditorProps {
  readonly controller: CanvasController;
  readonly assetUrls: CanvasAssetUrls;
  readonly title?: string;
  readonly className?: string;
  readonly height?: CSSProperties['height'];
  readonly licenseKey?: string;
  readonly onMount?: TLOnMountHandler;
}
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
