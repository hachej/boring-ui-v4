'use client';

import { HtmlViewer as RuntimeHtmlViewer } from '@boring/ui/html-viewer';
import type { HtmlViewerProps } from '@boring/ui/html-viewer';

export type { HtmlViewerProps } from '@boring/ui/html-viewer';

export function HtmlViewer({ className, ...props }: HtmlViewerProps) {
  return <RuntimeHtmlViewer {...props} className={['boring-html-recipe', className].filter(Boolean).join(' ')} />;
}
