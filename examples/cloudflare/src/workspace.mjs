// The agent's workspace in the Durable Object: one place for files (docs/architecture/FILES-GIT-EXEC.md). Its files are rows of the
// object's SQLite (`openSqliteFileSystem`), written as they happen; just-bash, isomorphic-git and Pi's
// native environment work on those rows, and one workspace provider (`createWorkspaceProvider`) serves the same files to the editors,
// `present` and the shared notes, with its journal in the same database: a save and its receipt commit in one `transactionSync`.
// Nothing is kept in memory, so there is nothing to save or flush and nothing to restore on open. Regular files and directories
// only: `ln` is refused, so no path can alias another. Nothing is pushed to a remote.
//
// A workspace saved by the earlier layout of this recipe (an in-memory copy saved file by file, beside a separate resource store) is
// moved into this one once, when the object first opens with this code (see legacy-storage.mjs).
import { AsyncLocalStorage } from 'node:async_hooks';
import { durableObjectSqliteConnection } from '@boring/files/sqlite-durable-object';
import { openSqliteFileSystem } from '@boring/files/sqlite-filesystem';
import { createWorkspaceJournal } from '@boring/files/journal';
import { createWorkspaceProvider, isTemporary } from '@boring/files/workspace';
import { createGitRepository } from '@boring/files/git';
import { createVirtualWorkspace } from '@boring/execution/virtual';
import { createVirtualGitFs, installVirtualGitCommand } from '@boring/execution/virtual-git';
import { initializeWorkspace, isInitialized, migrateLegacyStorage } from './legacy-storage.mjs';

export const WORKSPACE_ROOT = '/workspace';
/** The workspace's name in the object's database, its provider's instance id and the self-evolution extension's suffix. */
export const WORKSPACE_NAME = 'workspace';
export const WORKSPACE_PROVIDER = 'workspace';
/** ExecutionEnv methods that change files: they run in the workspace's mutation queue like commands. */
const WRITES = ['writeFile', 'appendFile', 'truncateFile', 'renameFile', 'createDir', 'remove', 'createTempDir', 'createTempFile'];
const GIT_READS = new Set(['status', 'log', 'branches', 'diff', 'currentBranch', 'read']);
const SEED = { 'README.md': '# Workspace\n\nThe agent\'s own files. It can read, write, run bash and use git here.\n' };

/** Every file of a workspace (`.git` included; the page hides it) as paths relative to its root, the provider's temporary files left out. */
async function list(fs, root, context) {
  const files = [];
  const walk = async directory => {
    const listing = await fs.listDir(directory, context);
    if (!listing.ok) return;
    for (const entry of listing.value.sort((a, b) => a.path < b.path ? -1 : 1)) {
      if (entry.kind === 'directory') await walk(entry.path);
      else if (!isTemporary(entry.path)) files.push({ path: entry.path.slice(root.length + 1), size: entry.size });
    }
  };
  await walk(root);
  return files;
}

/**
 * One workspace in a Durable Object's SQLite (or any `SqliteConnection` given as `connection`, for tests). Synchronous, so the object
 * can hand the provider to its agent definition when it is constructed: `migrate` first moves an earlier layout's data in (once; a
 * no-op afterwards), then the file system and the provider open. The git repository and Pi's environment over the same rows open on
 * first use (`repository()`), seeding a new workspace.
 * @param {{ storage?: object, connection?: object, context: object, name?: string, author?: { name: string, email: string }, migrate?: boolean }} options
 */
export function openCloudflareWorkspace({ storage, connection = durableObjectSqliteConnection(storage), context, name = WORKSPACE_NAME, author = { name: 'Agent', email: 'agent@example.invalid' }, migrate = true }) {
  const migrated = migrate ? migrateLegacyStorage(connection, { workspace: name, root: WORKSPACE_ROOT }) : undefined;
  const fs = openSqliteFileSystem({ connection, workspace: name, cwd: WORKSPACE_ROOT });
  const files = createWorkspaceProvider({ identity: { providerId: WORKSPACE_PROVIDER, instanceId: name, incarnation: fs.incarnation, viewId: 'published' }, fs, journal: createWorkspaceJournal(connection) });
  // The provider's mutation queue, re-entrant: work already inside it (a guarded write or edit, an agent-written tool's checked run)
  // calls the environment's writes and commands directly instead of waiting for itself. Every writer of this workspace goes through
  // it: Pi's file tools whatever extensions a conversation selected, bash, git, the editors' saves and `present`.
  const inside = new AsyncLocalStorage();
  const queue = { run: work => inside.getStore() ? work() : files.queue.run(() => inside.run(true, work)) };
  let opened;
  // Seeded once, when the workspace is genuinely new: an initialized workspace (this layout's marker, the earlier layout's, or one
  // with `.git`) keeps what it holds, an emptied one stays empty and one whose `.git` was deleted gets no new README or history.
  // The same pieces as `openVirtualRepository` (@boring/execution/virtual-sqlite), with that decision made from the marker.
  const repository = () => opened ??= (async () => {
    let git;
    const workspace = createVirtualWorkspace({ providerId: 'cloudflare', fs, onBash: bash => { if (git) installVirtualGitCommand({ bash, repository: git }); } });
    const lease = await workspace.acquire({ operationId: 'cloudflare-workspace', input: { cwd: WORKSPACE_ROOT } }, context);
    git = createGitRepository({ fs: createVirtualGitFs(workspace.filesystem), directory: WORKSPACE_ROOT, author, authorize: () => true });
    if (!isInitialized(connection, name, WORKSPACE_ROOT)) {
      // The seed only fills paths that are missing: it never writes over a file, whatever put it there.
      const seeded = [];
      for (const [path, text] of Object.entries(SEED)) {
        if (await workspace.filesystem.exists(`${WORKSPACE_ROOT}/${path}`)) continue;
        await workspace.filesystem.writeFile(`${WORKSPACE_ROOT}/${path}`, text);
        seeded.push(path);
      }
      await git.init();
      for (const path of seeded) await git.add(path);
      if (seeded.length) await git.commit('Initial commit');
      initializeWorkspace(connection, name);
    }
    const raw = lease.environment;
    return {
      raw, close: async () => { try { await lease.release(context); } finally { workspace.dispose(); } },
      // A command (bash, git, an agent-written tool) and every file write run in the queue: an editor's save never lands while a
      // command runs (a save from a revision the command then changed is a conflict), and nothing writes between an approved tool's
      // check and its run, even a conversation still selecting extensions from before the file guard.
      env: { ...raw, exec: (command, options, ctx) => queue.run(() => raw.exec(command, options, ctx)),
        ...Object.fromEntries(WRITES.map(method => [method, (...args) => queue.run(() => raw[method](...args))])) },
      // The git tool's changes (checkout, commit, ...) queue the same way; reads do not wait.
      repository: Object.fromEntries(Object.entries(git).map(([key, value]) => [key, typeof value !== 'function' ? value
        : GIT_READS.has(key) ? value : (...args) => queue.run(() => value(...args))])),
    };
  })().catch(error => { opened = undefined; throw error; });
  /** One exclusive operation of the workspace (the queue); the environment it gets does not wait for it. */
  const exclusive = work => queue.run(async () => work((await repository()).raw));
  return {
    // The provider as the agent's file guard sees it: its queue is the re-entrant one above.
    root: WORKSPACE_ROOT, connection, fs, files: { ...files, queue }, migrated, repository, exclusive,
    list: () => list(fs, WORKSPACE_ROOT, context),
    close: async () => { if (opened) await (await opened).close(); },
  };
}
