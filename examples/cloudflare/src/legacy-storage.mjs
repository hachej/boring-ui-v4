// The storage version of a Durable Object's database, and the move of data from the recipe's earlier storage layout into the SQLite
// workspace (workspace.mjs). The earlier layout kept the agent's files as an in-memory copy saved file by file (`boring_workspace_files`
// keyed by path alone, with `boring_workspace_directories`, `boring_workspace_links` and `boring_workspace_meta`), and published
// documents (the shared notes and artifacts) in a separate resource store (`boring_documents`, `boring_versions`, the artifact list in
// `artifacts/index.json`). Objects created before this code ('main' and every person's 'p-…' object) hold that data; it must stay readable.
//
// This is the one file allowed to name the removed store's tables (scripts/check-handlers.mjs exempts it). Everything runs in ONE write
// transaction (`transactionSync` on a Durable Object): a crash, or a document that cannot be placed, leaves the database as it was, and
// the next open runs the move again. Nothing is deleted: the old tables are renamed `boring_legacy_*` (the links, directories and meta
// tables are kept as they are), so an operator can still read them. `boring_storage_version` records the layout (2 = this one); a
// database written by a newer layout is refused rather than misread.
//
// - Files and folders keep their paths, bytes and modification times (the new backend has no modes: every file reads 0644). A
//   workspace the earlier layout had initialized stays initialized: it is never seeded again, even without `.git`.
// - Symbolic links cannot exist in the new backend: they are not moved, only counted (their rows stay in `boring_workspace_links`).
// - Each published document's latest version becomes a workspace file, at the first of these that is free or already holds the same
//   bytes: `<path>`, `documents/<path>`, `documents/<revision>/<path>`, `legacy-documents/<revision>/<path>`, then
//   `legacy-documents-<n>/<revision>/<path>` for the first free n. Never over another file. Where each landed is kept in `boring_legacy_document_files`; the move commits only when every document landed. The shared
//   notes follow that mapping (`sharedNotesPath`) in the page, links and the agent's instructions.
// - The artifact list becomes `boring_legacy_artifacts` (id → file), so a view link made for an artifact still opens it.
//
// Roll forward only: running the pre-migration Worker against a moved database is not supported (it cannot read the new file table).
// The old tables stay as `boring_legacy_*` for manual recovery. Should a previous Worker still have recreated its document tables, the
// next open moves those documents in too, beside the files already there, and drops the recreated tables.
import { openSqliteFileSystem } from '@boring/files/sqlite-filesystem';

export const STORAGE_VERSION = 2;
const columns = (connection, table) => connection.all(`SELECT name FROM pragma_table_info('${table}')`).map(row => row.name);
const exists = (connection, table) => columns(connection, table).length > 0;
const dirname = path => path.slice(0, path.lastIndexOf('/')) || '/';
const same = (left, right) => left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
const bytesOf = value => value instanceof Uint8Array ? value : new Uint8Array(value);
const safe = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_';

const stateTable = connection => connection.exec('CREATE TABLE IF NOT EXISTS boring_workspace_state (workspace TEXT PRIMARY KEY, initialized INTEGER NOT NULL) STRICT');
/** Whether workspace `workspace` was initialized (seeded once) by this layout or the earlier one, or holds a `.git`. */
export function isInitialized(connection, workspace, root) {
  stateTable(connection);
  return Boolean(connection.get('SELECT initialized FROM boring_workspace_state WHERE workspace = ?', workspace))
    || Boolean(connection.get('SELECT 1 AS found FROM boring_workspace_files WHERE workspace = ? AND path = ?', workspace, `${root}/.git`));
}
export function initializeWorkspace(connection, workspace) {
  stateTable(connection);
  connection.run('INSERT OR IGNORE INTO boring_workspace_state (workspace, initialized) VALUES (?, 1)', workspace);
}

/** The storage layout version of this database: 0 before any was recorded. */
export function storageVersion(connection) {
  if (!exists(connection, 'boring_storage_version')) return 0;
  return Number(connection.get('SELECT version FROM boring_storage_version WHERE id = 1')?.version ?? 0);
}

/** Whether this database still holds data in the earlier layout (first written, or written again by a previous Worker). */
export function hasLegacyStorage(connection) {
  const files = columns(connection, 'boring_workspace_files');
  return (files.length > 0 && !files.includes('workspace')) || exists(connection, 'boring_documents');
}

/**
 * Bring the database to this layout: move the earlier layout into workspace `workspace` (rooted at `root`) and record the version.
 * Returns what was moved, or undefined when there was nothing to move. Throws (changing nothing) for a newer layout or a document
 * that could not be placed.
 * @param {import('@boring/files/sqlite').SqliteConnection} connection
 * @param {{ workspace: string, root: string, now?: () => number }} options
 */
export function migrateLegacyStorage(connection, { workspace, root, now = Date.now }) {
  const version = storageVersion(connection);
  if (version > STORAGE_VERSION) throw new Error(`This database was written by storage layout ${version}; this code reads layout ${STORAGE_VERSION} and refuses to open it`);
  const record = () => {
    connection.exec('CREATE TABLE IF NOT EXISTS boring_storage_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL) STRICT');
    connection.run('INSERT INTO boring_storage_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version', STORAGE_VERSION);
  };
  if (!hasLegacyStorage(connection)) {
    if (version < STORAGE_VERSION) connection.transaction('write', record);
    return undefined;
  }
  return connection.transaction('write', () => {
    const report = { files: 0, directories: 0, links: 0, documents: 0, relocated: [], artifacts: 0, merged: false };
    const legacyFiles = exists(connection, 'boring_workspace_files') && !columns(connection, 'boring_workspace_files').includes('workspace');
    if (legacyFiles) connection.exec('ALTER TABLE boring_workspace_files RENAME TO boring_legacy_workspace_files');
    // The new tables, the workspace's incarnation and its root, in this same transaction.
    openSqliteFileSystem({ connection, workspace, cwd: root });

    const row = path => connection.get('SELECT kind, bytes FROM boring_workspace_files WHERE workspace = ? AND path = ?', workspace, path);
    const put = (path, kind, bytes, mtime) => connection.run('INSERT INTO boring_workspace_files (workspace, path, parent, kind, bytes, mtime_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace, path) DO UPDATE SET kind = excluded.kind, bytes = excluded.bytes, mtime_ms = excluded.mtime_ms',
      workspace, path, dirname(path), kind, bytes, mtime);
    /** Make `path` and its ancestors folders; false when a file is in the way. */
    const folder = (path, mtime) => {
      if (path === '/') return true;
      const found = row(path);
      if (found) return found.kind === 'directory';
      if (!folder(dirname(path), mtime)) return false;
      put(path, 'directory', null, mtime);
      report.directories++;
      return true;
    };
    /** Write a file unless a folder or a different file holds the path; true when the path now has these bytes. */
    const file = (path, bytes, mtime) => {
      const found = row(path);
      if (found) return found.kind === 'file' && same(bytesOf(found.bytes), bytes);
      if (!folder(dirname(path), mtime)) return false;
      put(path, 'file', bytes, mtime);
      return true;
    };

    if (legacyFiles) {
      if (exists(connection, 'boring_workspace_directories')) {
        for (const { path } of connection.all('SELECT path FROM boring_workspace_directories ORDER BY path')) folder(path, now());
      }
      const rows = connection.all('SELECT path, content, mode, mtime FROM boring_legacy_workspace_files ORDER BY path');
      for (const item of rows) {
        if (!file(item.path, bytesOf(item.content), Number(item.mtime))) throw new Error(`The earlier workspace file ${item.path} could not be moved`);
        report.files++;
      }
      const marked = exists(connection, 'boring_workspace_meta') && connection.get("SELECT value FROM boring_workspace_meta WHERE key = 'initialized'");
      if (marked || rows.length) initializeWorkspace(connection, workspace);
      if (exists(connection, 'boring_workspace_links')) report.links = Number(connection.get('SELECT count(*) AS n FROM boring_workspace_links')?.n ?? 0);
    }

    if (exists(connection, 'boring_documents')) {
      connection.exec(`CREATE TABLE IF NOT EXISTS boring_legacy_document_files (path TEXT PRIMARY KEY, file TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS boring_legacy_artifacts (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL) STRICT`);
      const landed = new Map();
      let list;
      for (const item of connection.all('SELECT d.path AS path, d.revision AS revision, v.bytes AS bytes FROM boring_documents d JOIN boring_versions v ON v.scope = d.scope AND v.path = d.path AND v.revision = d.revision ORDER BY d.scope, d.path')) {
        const bytes = bytesOf(item.bytes);
        if (item.path === 'artifacts/index.json') { list = bytes; continue; }
        const at = now(), revision = safe(item.revision);
        // The first of four plain places, then `legacy-documents-<n>/<revision>/<path>` with the first n that is free (a file or
        // folder in the way of one, its parents included, moves on to the next n).
        let target = [item.path, `documents/${item.path}`, `documents/${revision}/${item.path}`, `legacy-documents/${revision}/${item.path}`]
          .find(candidate => file(`${root}/${candidate}`, bytes, at));
        for (let n = 1; target === undefined && n <= 100_000; n++) {
          const candidate = `legacy-documents-${n}/${revision}/${item.path}`;
          if (file(`${root}/${candidate}`, bytes, at)) target = candidate;
        }
        // Never commit a move that leaves a published document without a file.
        if (target === undefined) throw new Error(`The published document ${item.path} could not be placed in the workspace`);
        if (target !== item.path) report.relocated.push({ path: item.path, file: target });
        connection.run('INSERT INTO boring_legacy_document_files (path, file) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET file = excluded.file', item.path, target);
        landed.set(item.path, target);
        report.documents++;
      }
      // Anything moved makes the workspace an existing one: it is never seeded over.
      if (report.documents) initializeWorkspace(connection, workspace);
      let entries = [];
      try { entries = list ? JSON.parse(new TextDecoder().decode(list)).artifacts ?? [] : []; } catch { entries = []; }
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (typeof entry?.id !== 'string' || typeof entry.path !== 'string' || !landed.has(entry.path)) continue;
        connection.run('INSERT OR REPLACE INTO boring_legacy_artifacts (id, path, title) VALUES (?, ?, ?)', entry.id, landed.get(entry.path), typeof entry.title === 'string' ? entry.title : entry.id);
        report.artifacts++;
      }
      if (exists(connection, 'boring_legacy_documents')) {
        // Recreated by a previous Worker after a rollback: keep its rows beside the first move's, then drop the recreated tables.
        connection.exec(`INSERT OR REPLACE INTO boring_legacy_versions SELECT * FROM boring_versions;
          INSERT OR REPLACE INTO boring_legacy_documents SELECT * FROM boring_documents;
          DROP TABLE boring_documents; DROP TABLE boring_versions`);
        report.merged = true;
      } else {
        connection.exec('ALTER TABLE boring_documents RENAME TO boring_legacy_documents');
        connection.exec('ALTER TABLE boring_versions RENAME TO boring_legacy_versions');
      }
    }
    record();
    return report;
  });
}

/** Where the shared notes live: `notes.md`, unless the move placed the published notes elsewhere (beside an agent file of that name). */
export function sharedNotesPath(connection) {
  if (!exists(connection, 'boring_legacy_document_files')) return 'notes.md';
  return connection.get("SELECT file FROM boring_legacy_document_files WHERE path = 'notes.md'")?.file ?? 'notes.md';
}

/** The workspace file an artifact made before this change landed in (for its old view links), or undefined. */
export function legacyArtifact(connection, id) {
  if (!exists(connection, 'boring_legacy_artifacts')) return undefined;
  return connection.get('SELECT path, title FROM boring_legacy_artifacts WHERE id = ?', id) ?? undefined;
}
