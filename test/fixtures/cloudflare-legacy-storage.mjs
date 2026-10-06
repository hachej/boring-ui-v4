// A Durable Object database in the Cloudflare recipe's earlier storage layout, as the deployed objects ('main', 'p-…') hold it: the agent's
// files saved path by path (with directories, a symbolic link and the initialization marker) and the separate resource store of
// published documents (the shared notes in two versions, one artifact and its list, and a document whose path a different workspace
// file already holds). The workspace's git history is real: it is made with today's tools in a scratch database, then written out in
// the old table shape. Exempt from the removed-API rule (scripts/check-handlers.mjs MIGRATIONS) because it must name the old tables.
// Fictional content only.
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeConnection } from '@boring/files/sqlite';
import { openSqliteFileSystem } from '@boring/files/sqlite-filesystem';
import { openVirtualRepository } from '@boring/execution/virtual-sqlite';

const text = value => new TextEncoder().encode(value);

/** Fictional content of the fixture, for the assertions. */
export const LEGACY = {
  // The agent's own notes.md and documents/plan.md differ from the published ones: the published copies must land elsewhere.
  files: { 'README.md': '# Workspace\n\nFictional legacy workspace.\n', 'plan.md': 'v1 fictional plan (agent)\n', 'notes/today.md': 'fictional note of the day\n',
    'notes.md': 'the agent\'s own fictional scratch notes\n', 'documents/plan.md': 'an unrelated fictional file\n',
    // Every named place for the published plan.md is taken too, and a file stands where the first numbered folder would go.
    'documents/fictional-plan-r1/plan.md': 'another unrelated fictional file\n', 'legacy-documents/fictional-plan-r1/plan.md': 'a third unrelated fictional file\n',
    'legacy-documents-1': 'a fictional file in the way\n' },
  emptyDirectory: '/workspace/empty',
  link: { path: '/workspace/alias', target: 'notes' },
  notes: ['first fictional shared notes\n', 'second fictional shared notes\n'],
  artifact: { id: 'a-fictional-1', path: 'artifacts/a-fictional-1.md', title: 'Fictional report', body: '# Fictional report\n\nNothing real here.\n' },
  /** A published document whose path and `documents/` path the agent's workspace already holds with other bytes. */
  clashing: { path: 'plan.md', revision: 'fictional-plan-r1', body: 'fictional plan (published copy)\n' },
  /** What a previous Worker publishes after a rollback, in the document store it recreates. */
  rollbackNotes: 'fictional notes written during the rollback\n',
  /** A published README.md of an object whose workspace was never opened. */
  publishedReadme: '# Fictional published readme\n',
  commit: 'Fictional legacy commit',
};

/** The agent's files with a real `.git`, as absolute paths with bytes, and every directory. */
async function legacyTree(git) {
  const scratch = openNodeConnection(':memory:');
  const fs = openSqliteFileSystem({ connection: scratch, workspace: 'scratch', cwd: '/workspace' });
  const repo = await openVirtualRepository({ fs, root: '/workspace', seed: LEGACY.files, seedMessage: LEGACY.commit, context, providerId: 'fixture' });
  await repo.close();
  const rows = scratch.all("SELECT path, kind, bytes, mtime_ms FROM boring_workspace_files WHERE workspace = 'scratch' AND path LIKE '/workspace/%' ORDER BY path")
    .filter(row => git || !row.path.startsWith('/workspace/.git'));
  scratch.close();
  return { files: rows.filter(row => row.kind === 'file'), directories: rows.filter(row => row.kind === 'directory').map(row => row.path) };
}

/** Write the earlier layout into `db` (a node:sqlite database behind the test's Durable Object storage). `git: false`: an initialized workspace whose `.git` was deleted. */
export async function seedLegacyLayout(db = new DatabaseSync(':memory:'), { git = true, documentsOnly = false } = {}) {
  if (documentsOnly) return seedDocumentsOnly(db);
  const tree = await legacyTree(git);
  db.exec(`
    CREATE TABLE boring_workspace_files (path TEXT PRIMARY KEY, content BLOB NOT NULL, mode INTEGER NOT NULL, mtime INTEGER NOT NULL);
    CREATE TABLE boring_workspace_directories (path TEXT PRIMARY KEY);
    CREATE TABLE boring_workspace_links (path TEXT PRIMARY KEY, target TEXT NOT NULL);
    CREATE TABLE boring_workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE boring_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE boring_documents (scope TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY (scope, path)) STRICT;
    CREATE TABLE boring_versions (scope TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL, bytes BLOB NOT NULL, media_type TEXT NOT NULL, PRIMARY KEY (scope, path, revision)) STRICT;
    CREATE TABLE boring_operations (scope TEXT NOT NULL, principal TEXT NOT NULL, initiator TEXT NOT NULL, operation TEXT NOT NULL, digest TEXT NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY (scope, principal, initiator, operation)) STRICT;
    CREATE TABLE boring_changes (scope TEXT NOT NULL, principal TEXT NOT NULL, initiator TEXT NOT NULL, operation TEXT NOT NULL, ordinal INTEGER NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, before_revision TEXT, after_revision TEXT, PRIMARY KEY (scope, principal, initiator, operation, ordinal)) STRICT;
  `);
  const file = db.prepare('INSERT INTO boring_workspace_files (path, content, mode, mtime) VALUES (?, ?, ?, ?)');
  for (const row of tree.files) file.run(row.path, row.bytes, 0o100644, Number(row.mtime_ms));
  const directory = db.prepare('INSERT INTO boring_workspace_directories (path) VALUES (?)');
  for (const path of [...tree.directories, LEGACY.emptyDirectory]) directory.run(path);
  db.prepare('INSERT INTO boring_workspace_links (path, target) VALUES (?, ?)').run(LEGACY.link.path, LEGACY.link.target);
  db.exec("INSERT INTO boring_workspace_meta (key, value) VALUES ('initialized', '1')");

  const version = db.prepare('INSERT INTO boring_versions VALUES (?, ?, ?, ?, ?)');
  const latest = db.prepare('INSERT OR REPLACE INTO boring_documents VALUES (?, ?, ?)');
  const publish = (path, revision, body, mediaType) => { version.run('recipe', path, revision, text(body), mediaType); latest.run('recipe', path, revision); };
  LEGACY.notes.forEach((body, index) => publish('notes.md', `fictional-notes-r${index + 1}`, body, 'text/markdown'));
  publish(LEGACY.artifact.path, 'fictional-artifact-r1', LEGACY.artifact.body, 'text/markdown');
  publish('artifacts/index.json', 'fictional-index-r1', JSON.stringify({ artifacts: [{ id: LEGACY.artifact.id, title: LEGACY.artifact.title, type: 'markdown', mediaType: 'text/markdown', path: LEGACY.artifact.path, ordinal: 1 }] }), 'application/json');
  publish(LEGACY.clashing.path, 'fictional-plan-r1', LEGACY.clashing.body, 'text/markdown');
  db.prepare('INSERT INTO boring_operations VALUES (?, ?, ?, ?, ?, ?)').run('recipe', 'agent', 'owner', 'fictional-op-1', 'fictional-digest', 'fictional-evidence');
  return db;
}

/**
 * What the previous Worker does to a database this code already moved, after a rollback: its file query fails on the new file table
 * (returned, not thrown), and its document store recreates the old tables and publishes newer notes.
 */
export function previousWorkerRuns(db) {
  let failure;
  try { db.prepare('SELECT path, content, mode, mtime FROM boring_workspace_files').all(); } catch (error) { failure = error.message; }
  db.exec(`
    CREATE TABLE IF NOT EXISTS boring_documents (scope TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY (scope, path)) STRICT;
    CREATE TABLE IF NOT EXISTS boring_versions (scope TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL, bytes BLOB NOT NULL, media_type TEXT NOT NULL, PRIMARY KEY (scope, path, revision)) STRICT;
  `);
  db.prepare('INSERT INTO boring_versions VALUES (?, ?, ?, ?, ?)').run('recipe', 'notes.md', 'fictional-notes-rollback', text(LEGACY.rollbackNotes), 'text/markdown');
  db.prepare('INSERT INTO boring_documents VALUES (?, ?, ?)').run('recipe', 'notes.md', 'fictional-notes-rollback');
  return failure;
}

/** An object that only ever published documents (its workspace was never opened), one of them a README.md. */
function seedDocumentsOnly(db) {
  db.exec(`
    CREATE TABLE boring_documents (scope TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY (scope, path)) STRICT;
    CREATE TABLE boring_versions (scope TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL, bytes BLOB NOT NULL, media_type TEXT NOT NULL, PRIMARY KEY (scope, path, revision)) STRICT;
  `);
  db.prepare('INSERT INTO boring_versions VALUES (?, ?, ?, ?, ?)').run('recipe', 'README.md', 'fictional-readme-r1', text(LEGACY.publishedReadme), 'text/markdown');
  db.prepare('INSERT INTO boring_documents VALUES (?, ?, ?)').run('recipe', 'README.md', 'fictional-readme-r1');
  return db;
}
