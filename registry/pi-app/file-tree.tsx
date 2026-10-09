'use client';

// A searchable tree of the host's files: folders open and close, choosing a file calls `onOpen`. The host decides what is listed and how
// each entry opens (for example `{ kind: 'file', path }` or an artifact view in `AgentWorkspace`); the tree only presents them.
import { useMemo, useState } from 'react';
import { ChevronRightIcon, FileCodeIcon, FileIcon, FileTextIcon, FolderIcon, FolderOpenIcon, ImageIcon, SearchIcon } from 'lucide-react';
import type { BlockIcon } from '../button/actions';
import { cn } from '../utils/utils';
import { useAppText } from './app-labels';
import { kindOf } from './file-kinds';

export interface FileTreeItem {
  /** Unique among the items; `activeId` and `onOpen` refer to it. */
  readonly id: string;
  /** The folders that contain it, outermost first (`[]` at the root). */
  readonly folders: readonly string[];
  /** The name shown. */
  readonly label: string;
  /** Picks the icon by extension (`kindOf`); defaults to `label`. */
  readonly path?: string | undefined;
  /** A second line, for example the date or the type. */
  readonly detail?: string | undefined;
}

interface Folder { readonly name: string; readonly key: string; readonly folders: Folder[]; readonly files: FileTreeItem[] }

const ICONS: Readonly<Record<string, BlockIcon>> = { markdown: FileTextIcon, text: FileTextIcon, html: FileCodeIcon, image: ImageIcon };
const iconOf = (item: FileTreeItem): BlockIcon => ICONS[kindOf(item.path ?? item.label)] ?? FileIcon;

function treeOf(items: readonly FileTreeItem[]): Folder {
  const root: Folder = { name: '', key: '', folders: [], files: [] };
  for (const item of items) {
    let at = root;
    for (const name of item.folders) {
      const key = `${at.key}/${name}`;
      let next = at.folders.find(folder => folder.key === key);
      if (!next) { next = { name, key, folders: [], files: [] }; at.folders.push(next); }
      at = next;
    }
    at.files.push(item);
  }
  return root;
}

/**
 * The files as a tree with a search field. Folders start open; a search shows every match with its folders. The open file is marked
 * with `aria-current`. Labels come from the block's text (`librarySearch`, `libraryEmpty`, `libraryNoMatch`).
 */
export function FileTree({ items, activeId, onOpen, className }: {
  readonly items: readonly FileTreeItem[];
  readonly activeId?: string | undefined;
  readonly onOpen: (item: FileTreeItem) => void;
  readonly className?: string;
}) {
  const { labels } = useAppText();
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const needle = query.trim().toLocaleLowerCase();
  const shown = useMemo(() => needle ? items.filter(item => [item.label, item.detail ?? '', ...item.folders].some(text => text.toLocaleLowerCase().includes(needle))) : items, [items, needle]);
  const tree = useMemo(() => treeOf(shown), [shown]);
  const toggle = (key: string) => setClosed(current => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; });

  const renderFolder = (folder: Folder, depth: number) => <>
    {folder.folders.map(child => {
      const open = Boolean(needle) || !closed.has(child.key);
      const Icon = open ? FolderOpenIcon : FolderIcon;
      return <li key={child.key}>
        <button type="button" data-testid="file-tree-folder" aria-expanded={open} onClick={() => toggle(child.key)} style={{ paddingLeft: `${depth * 12 + 8}px` }}
          className="flex min-h-9 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-sm font-medium text-foreground hover:bg-muted">
          <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{child.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{countOf(child)}</span>
        </button>
        {open && <ul className="m-0 list-none p-0">{renderFolder(child, depth + 1)}</ul>}
      </li>;
    })}
    {folder.files.map(item => {
      const Icon = iconOf(item);
      const current = item.id === activeId;
      return <li key={item.id}>
        <button type="button" data-testid="file-tree-file" data-id={item.id} aria-current={current ? 'true' : undefined} onClick={() => onOpen(item)} style={{ paddingLeft: `${depth * 12 + 28}px` }}
          className={cn('flex min-h-9 w-full cursor-pointer items-start gap-2 rounded-md py-1.5 pr-2 text-left text-sm hover:bg-muted', current && 'bg-muted font-medium')}>
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1"><span className="block truncate">{item.label}</span>
            {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}</span>
        </button>
      </li>;
    })}
  </>;

  return <div data-testid="file-tree" className={cn('flex min-h-0 flex-1 flex-col', className)}>
    <label className="mx-3 mt-3 mb-2 flex shrink-0 items-center gap-2 rounded-md border border-border px-2">
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input type="search" data-testid="file-tree-search" value={query} onChange={event => setQuery(event.target.value)} placeholder={labels.librarySearch} aria-label={labels.librarySearch}
        className="h-9 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
    </label>
    <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
      {shown.length === 0
        ? <p role="status" className="m-0 px-2 py-4 text-sm text-muted-foreground">{needle ? labels.libraryNoMatch(query.trim()) : labels.libraryEmpty}</p>
        : <ul className="m-0 list-none p-0">{renderFolder(tree, 0)}</ul>}
    </div>
  </div>;
}

const countOf = (folder: Folder): number => folder.files.length + folder.folders.reduce((sum, child) => sum + countOf(child), 0);
