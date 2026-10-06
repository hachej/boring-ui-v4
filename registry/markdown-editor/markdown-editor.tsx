'use client';

import { MarkdownEditor as RuntimeMarkdownEditor } from '@boring/ui/markdown-editor';
import type { MarkdownEditorProps } from '@boring/ui/markdown-editor';

export type { MarkdownEditorProps } from '@boring/ui/markdown-editor';

export function MarkdownEditor({ className, ...props }: MarkdownEditorProps) {
  return <RuntimeMarkdownEditor {...props} className={['boring-markdown-recipe', className].filter(Boolean).join(' ')} />;
}
