import git from 'isomorphic-git';
import type { PromiseFsClient, WalkerEntry } from 'isomorphic-git';
import { posix } from 'node:path';

export type GitOperation = 'init' | 'status' | 'add' | 'remove' | 'commit' | 'log' | 'branches' | 'branch' | 'checkout' | 'diff';
export type GitView = { readonly kind: 'tree'; readonly ref: string } | { readonly kind: 'index' } | { readonly kind: 'worktree' };
export interface GitFileVersion {
  readonly oid: string;
  readonly mode: number;
  readonly bytes: Uint8Array;
}
export interface GitFileChange {
  readonly path: string;
  readonly before: GitFileVersion | null;
  readonly after: GitFileVersion | null;
}
export interface GitRepositoryOptions<FS extends PromiseFsClient> {
  readonly fs: FS;
  readonly directory: string;
  readonly author: NonNullable<Parameters<typeof git.commit>[0]['author']>;
  /** A current repository-wide grant for the host-bound caller, including all worktree and Git metadata. */
  readonly authorize: (operation: GitOperation) => boolean | Promise<boolean>;
  /** Returned diff limits. Upstream may allocate an entire blob before its size is checked. */
  readonly diffLimits?: { readonly files: number; readonly bytes: number };
}
export class GitOperationError extends Error {
  constructor(message: string, readonly effects: 'none' | 'possible', options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitOperationError';
  }
}

function name(value: string, label: string): string {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError(`Invalid Git ${label}`);
  return value;
}
/** check-ref-format rules, so a name can never resolve outside refs/ or the repository. */
function refname(value: string): string {
  name(value, 'reference');
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value === '@' || value.includes('//')
    || value.includes('..') || value.includes('@{') || /[ ~^:?*[\\]/.test(value)
    || value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw new TypeError('Invalid Git reference');
  return value;
}
function filepath(value: string): string {
  name(value, 'path');
  if (value.startsWith('/') || value.includes('\\') || value.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) throw new TypeError('Git paths must stay in the selected worktree');
  return value;
}

/** Borrow one filesystem and share this instance across callers. Raw filesystem writers do not take this queue. */
export function createGitRepository<FS extends PromiseFsClient>(options: GitRepositoryOptions<FS>) {
  const { fs, authorize } = options;
  const directory = name(options.directory, 'directory');
  if (!directory.startsWith('/') || posix.normalize(directory) !== directory) throw new TypeError('Git directory must be an absolute normalized path');
  const author = { ...options.author };
  const repo = { fs, dir: directory };
  const limits = { files: 100, bytes: 1024 * 1024, ...options.diffLimits };
  if (![limits.files, limits.bytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Git diff limits must be positive safe integers');
  let pending: Promise<void> = Promise.resolve();
  function run<Value>(operation: GitOperation, mutation: boolean, signal: AbortSignal | undefined, execute: () => Promise<Value>): Promise<Value> {
    const result = pending.then(async () => {
      let started = false;
      try {
        if (signal?.aborted) throw new Error('Git operation aborted before execution');
        if (await authorize(operation) !== true) throw new Error('Git repository authorization denied');
        if (signal?.aborted) throw new Error('Git operation aborted before execution');
        started = true;
        const value = await execute();
        if (signal?.aborted) throw new Error('Git operation aborted after execution');
        if (await authorize(operation) !== true) throw new Error('Git repository authorization changed during execution');
        if (signal?.aborted) throw new Error('Git operation aborted after execution');
        return value;
      } catch (cause) {
        const effects = started && mutation ? 'possible' : 'none';
        throw new GitOperationError(`${cause instanceof Error ? cause.message : String(cause)}${effects === 'possible' ? '; prior Git effects may remain' : ''}`, effects, { cause });
      }
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  function tree(view: GitView) {
    switch (view.kind) {
      case 'tree': return git.TREE({ ref: refname(view.ref) });
      case 'index': return git.STAGE();
      case 'worktree': return git.WORKDIR({ refresh: false });
    }
  }
  return Object.freeze({
    fs, directory,
    init: (signal?: AbortSignal) => run('init', true, signal, () => git.init({ ...repo, defaultBranch: 'main' })),
    status: (signal?: AbortSignal) => run('status', false, signal, () => git.statusMatrix({ ...repo, refresh: false })),
    add: (path: string, signal?: AbortSignal) => {
      const selected = filepath(path);
      return run('add', true, signal, () => git.add({ ...repo, filepath: selected }));
    },
    remove: (path: string, signal?: AbortSignal) => {
      const selected = filepath(path);
      return run('remove', true, signal, () => git.remove({ ...repo, filepath: selected }));
    },
    commit: (message: string, signal?: AbortSignal) => {
      if (typeof message !== 'string' || !message.trim() || message.includes('\0')) throw new TypeError('Invalid Git message');
      const selected = message;
      return run('commit', true, signal, () => git.commit({ ...repo, author, message: selected }));
    },
    log: (signal?: AbortSignal) => run('log', false, signal, () => git.log({ ...repo, depth: 20 })),
    branches: (signal?: AbortSignal) => run('branches', false, signal, () => git.listBranches(repo)),
    branch: (ref: string, signal?: AbortSignal) => {
      const selected = refname(ref);
      return run('branch', true, signal, () => git.branch({ ...repo, ref: selected }));
    },
    checkout: (ref: string, signal?: AbortSignal) => {
      const selected = refname(ref);
      return run('checkout', true, signal, () => git.checkout({ ...repo, ref: selected }));
    },
    diff: (before: GitView, after: GitView, signal?: AbortSignal) => {
      const trees = [tree(before), tree(after)];
      return run('diff', false, signal, async () => {
        const changes: GitFileChange[] = [];
        let bytes = 0;
        async function version(entry: WalkerEntry | null): Promise<GitFileVersion | null> {
          if (!entry) return null;
          if (await entry.type() !== 'blob') throw new Error('Git diff supports blob entries only');
          const oid = await entry.oid();
          const content = await entry.content() ?? (await git.readBlob({ ...repo, oid })).blob;
          const copied = Uint8Array.from(content);
          bytes += copied.length;
          if (bytes > limits.bytes) throw new Error('Git diff byte limit exceeded');
          return { oid, mode: await entry.mode(), bytes: copied };
        }
        await git.walk({ ...repo, trees, iterate: async (walk, children) => {
          for (const child of children) await walk(child);
          return [];
        }, map: async (path, entries) => {
          if (path === '.git') return null;
          if (signal?.aborted) throw new Error('Git diff aborted');
          let left = entries[0] ?? null, right = entries[1] ?? null;
          if (left && await left.type() === 'tree') left = null;
          if (right && await right.type() === 'tree') right = null;
          if (!left && !right) return;
          if (left && right && await left.oid() === await right.oid() && await left.mode() === await right.mode()) return;
          if (changes.length >= limits.files) throw new Error('Git diff file limit exceeded');
          const change = { path, before: await version(left), after: await version(right) };
          changes.push(change);
        } });
        return changes.sort((left, right) => left.path.localeCompare(right.path));
      });
    },
  });
}

export type GitRepository = ReturnType<typeof createGitRepository>;
