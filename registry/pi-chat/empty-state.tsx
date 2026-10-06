import type { ReactNode } from 'react';
import { MessagesSquareIcon } from 'lucide-react';

export interface Suggestion { readonly label: string; readonly hint?: string; readonly text: string }

/** Shown before the first message: a quiet title and optional starter prompts that fill the composer. */
export function EmptyState({ title, description, suggestions, onSelect, children }: {
  readonly title: string; readonly description?: string; readonly suggestions?: readonly Suggestion[]; readonly onSelect?: (text: string) => void; readonly children?: ReactNode;
}) {
  return <div data-testid="empty-state" className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
    <span className="flex size-12 items-center justify-center rounded-2xl border border-border bg-muted/50 text-muted-foreground"><MessagesSquareIcon className="size-6" strokeWidth={1.5} aria-hidden="true" /></span>
    <div className="space-y-1.5">
      <p className="m-0 text-lg font-semibold tracking-tight">{title}</p>
      <p className="m-0 max-w-sm text-sm text-muted-foreground">{description ?? 'Start a conversation.'}</p>
    </div>
    {children}
    {suggestions && suggestions.length > 0 && <ul className="m-0 grid w-full max-w-md list-none gap-2 p-0">
      {suggestions.map(item => <li key={item.label}><button type="button" onClick={() => onSelect?.(item.text)} data-testid="suggestion"
        className="flex w-full cursor-pointer flex-col gap-0.5 rounded-xl border border-border bg-background px-4 py-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60">
        <span className="text-sm font-medium">{item.label}</span>{item.hint && <span className="text-xs text-muted-foreground">{item.hint}</span>}</button></li>)}
    </ul>}
  </div>;
}
