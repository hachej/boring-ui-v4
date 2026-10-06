'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { CheckIcon, HistoryIcon } from 'lucide-react';
import { cn } from '../utils/utils';
import { IconButton as ViewerIconButton } from '../button/button';

/** One row of a viewer menu. With `checked` set (true or false) the row is a radio choice, otherwise a plain action. */
export interface ViewerMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  /** Small text after the label, for example "Latest". */
  readonly hint?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly onSelect: () => void;
}

export interface ViewerMenuProps {
  /** Accessible name and tooltip of the trigger; also the name of the menu. */
  readonly label: string;
  readonly icon: ReactNode;
  readonly items: readonly ViewerMenuItem[];
  readonly testId?: string;
  /** Which edge of the trigger the menu lines up with. */
  readonly align?: 'start' | 'end';
  readonly className?: string;
}

const ITEM = 'flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-45 max-sm:h-11 pointer-coarse:h-11';

/**
 * An icon button that opens a small menu: arrow keys, Home/End and type-free roving focus, Escape (focus returns to the trigger), Tab and
 * an outside press close it. Used for the viewer's overflow actions and the version history.
 */
export function ViewerMenu({ label, icon, items, testId = 'viewer-menu', align = 'end', className }: ViewerMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const radio = items.some(item => item.checked !== undefined);

  useEffect(() => {
    if (!open) return;
    const list = root.current?.querySelectorAll<HTMLElement>('[role^=menuitem]:not(:disabled)');
    const wanted = root.current?.querySelector<HTMLElement>('[aria-checked=true]:not(:disabled)') ?? list?.[0];
    wanted?.focus();
    const away = (event: Event) => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('[role^=menuitem]:not(:disabled)') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => { event.preventDefault(); rows[(index + rows.length) % rows.length]?.focus(); };
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(false);
    else if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(-1);
  };

  return <div ref={root} data-viewer-menu className={cn('relative', className)} onKeyDown={event => { if (open) keys(event); }}>
    <ViewerIconButton ref={trigger} label={label} data-testid={testId} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true); } }}>{icon}</ViewerIconButton>
    {open && <div id={menuId} role="menu" aria-label={label} data-testid={`${testId}-list`}
      className={cn('absolute top-full z-50 mt-1 grid max-h-72 min-w-48 gap-0.5 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg', 'max-sm:fixed max-sm:inset-x-2 max-sm:top-auto max-sm:bottom-2 max-sm:mt-0 max-sm:max-h-[70vh] max-sm:rounded-xl max-sm:p-1.5', align === 'end' ? 'right-0' : 'left-0')}>
      {items.map(item => <button key={item.id} type="button" tabIndex={-1} role={radio ? 'menuitemradio' : 'menuitem'} {...(radio ? { 'aria-checked': item.checked === true } : {})}
        disabled={item.disabled} data-testid={item.testId ?? `${testId}-${item.id}`} data-item={item.id} className={ITEM}
        onClick={() => { close(true); item.onSelect(); }}>
        {item.icon ?? (radio ? <span className="size-4 shrink-0">{item.checked && <CheckIcon className="size-4" aria-hidden="true" />}</span> : null)}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.hint && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{item.hint}</span>}
      </button>)}
    </div>}
  </div>;
}

/** One saved version in a history menu. */
export interface ViewerVersion { readonly id: string; readonly label: string; readonly latest?: boolean }

/**
 * The version history of a document: an icon button (tooltip "Version history") that opens the list of versions, newest first, with the
 * latest marked and the one on display checked.
 */
export function ViewerVersions({ versions, current, onSelect, testId = 'viewer-versions', label = 'Version history' }: {
  readonly versions: readonly ViewerVersion[];
  readonly current: string;
  readonly onSelect: (id: string) => void;
  readonly testId?: string;
  readonly label?: string;
}) {
  return <ViewerMenu label={label} testId={testId} align="end" icon={<HistoryIcon className="size-4" aria-hidden="true" />}
    items={versions.map(version => ({ id: version.id, label: version.label, ...(version.latest ? { hint: 'Latest' } : {}), checked: version.id === current, testId: `${testId}-item`, onSelect: () => onSelect(version.id) }))} />;
}
