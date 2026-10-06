import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openNodeConnection } from '@boring/files/sqlite';
import { openSqliteFileSystem } from '@boring/files/sqlite-filesystem';
import { createWorkspaceJournal } from '@boring/files/journal';
import { createWorkspaceProvider } from '@boring/files/workspace';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';

const [directory, mode] = process.argv.slice(2);

if (mode === 'sqlite-workspace') {
  // A two-file conditional batch on the SQLite backend, stopped for good inside its one transaction: the first file row is written,
  // the second file, the receipt and the history are not.
  const prepare = DatabaseSync.prototype.prepare;
  let armed = false;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (armed && sql.startsWith('INSERT INTO boring_workspace_files')) {
      const run = statement.run.bind(statement);
      statement.run = (...parameters) => {
        const result = run(...parameters);
        const count = query => prepare.call(this, query).get().n;
        writeFileSync(join(directory, 'staged.json'), JSON.stringify({
          notes: new TextDecoder().decode(prepare.call(this, "SELECT bytes FROM boring_workspace_files WHERE path = '/workspace/notes.md'").get().bytes),
          intents: count('SELECT count(*) AS n FROM boring_intents'), receipts: count('SELECT count(*) AS n FROM boring_operations'),
        }));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        return result;
      };
    }
    return statement;
  };
  const connection = openNodeConnection(join(directory, 'workspace.sqlite'));
  const fs = openSqliteFileSystem({ connection, workspace: 'fictional', cwd: '/workspace' });
  const files = createWorkspaceProvider({ identity: { providerId: 'workspace', instanceId: 'fictional', incarnation: fs.incarnation, viewId: 'published' }, fs, journal: createWorkspaceJournal(connection) });
  const access = { scopeId: 'fictional-project', principalId: 'editor', initiatorId: 'reviewer' };
  const target = path => ({ resource: { providerId: 'workspace', path }, view: { kind: 'published' } });
  const created = await files.publication.publish({ operationId: 'seed', atomicity: 'all-or-nothing', changes: [{ kind: 'create', target: target('notes.md'), expected: { kind: 'absent' }, bytes: new TextEncoder().encode('original text'), mediaType: 'text/markdown' }] }, access);
  armed = true;
  await files.publication.publish({ operationId: 'interrupted-batch', atomicity: 'all-or-nothing', changes: [
    { kind: 'replace', target: created.receipt.changes[0].after, bytes: new TextEncoder().encode('replacement text'), mediaType: 'text/markdown' },
    { kind: 'create', target: target('summary.md'), expected: { kind: 'absent' }, bytes: new TextEncoder().encode('summary text'), mediaType: 'text/markdown' },
  ] }, access);
  throw new Error('Fault injection did not stop the SQLite workspace transaction');
}

if (mode === 'workspace') {
  // A conditional write on disk, stopped for good between the journal intent and the rename.
  const db = new DatabaseSync(join(directory, 'journal.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  const connection = {
    exec: sql => { db.exec(sql); }, run: (sql, ...params) => { db.prepare(sql).run(...params); },
    get: (sql, ...params) => db.prepare(sql).get(...params), all: (sql, ...params) => db.prepare(sql).all(...params),
    transaction: (kind, work) => { db.exec(kind === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  };
  const env = new NodeExecutionEnv({ cwd: join(directory, 'workspace') });
  const fs = new Proxy(env, { get: (target, name) => {
    if (name === 'renameFile') return () => {
      writeFileSync(join(directory, 'intent.json'), JSON.stringify({ intents: db.prepare('SELECT count(*) AS n FROM boring_intents').get().n, receipts: db.prepare('SELECT count(*) AS n FROM boring_operations').get().n }));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    const value = Reflect.get(target, name);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const identity = { providerId: 'documents', instanceId: 'disk', incarnation: 'workspace-one', viewId: 'published' };
  const provider = createWorkspaceProvider({ identity, fs, journal: createWorkspaceJournal(connection) });
  const read = await provider.read({ target: { resource: { providerId: 'documents', path: 'notes.md' }, view: { kind: 'published' } }, revision: { kind: 'latest' } }, { scopeId: 'fictional-project', principalId: 'editor', initiatorId: 'reviewer' });
  await provider.publication.publish({ operationId: 'interrupted-save', atomicity: 'all-or-nothing', changes: [{
    kind: 'replace', target: read.snapshot.ref, bytes: new TextEncoder().encode('replacement text'), mediaType: 'text/markdown',
  }] }, { scopeId: 'fictional-project', principalId: 'editor', initiatorId: 'reviewer' });
  throw new Error('Fault injection did not stop the workspace write');
}

throw new Error(`Unknown mode: ${mode}`);
