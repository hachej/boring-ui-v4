import type { DatabaseSync } from 'node:sqlite';
import type { SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';

/**
 * The synchronous SQL surface the SQLite workspace backend (`openSqliteFileSystem`) and the workspace journal
 * (`createWorkspaceJournal`) need: the statement methods of Pi Durable's `SqliteExecutor` (same names, positional
 * `SqliteValue` bindings, rows as plain objects) without promises, plus a transaction. It is synchronous on purpose: a conditional
 * write is one critical section (conflict check, file rows, receipt) that must commit or roll back as a unit, and a synchronous
 * callback cannot interleave with another operation. Pi's own `SqliteDatabase` is asynchronous, so it needs a queue to give that
 * guarantee; engines whose SQL is synchronous (`node:sqlite`, a Durable Object's `ctx.storage.sql`) satisfy this directly.
 */
export interface SqliteConnection {
  readonly exec: (sql: string) => void;
  readonly run: (sql: string, ...params: SqliteValue[]) => void;
  readonly get: <Row extends object = Record<string, unknown>>(sql: string, ...params: SqliteValue[]) => Row | undefined;
  readonly all: <Row extends object = Record<string, unknown>>(sql: string, ...params: SqliteValue[]) => Row[];
  /**
   * Run `work` atomically: every statement it issues commits together, or none does when it throws (the error is rethrown).
   * `write` takes the write lock up front where the engine distinguishes it. `work` must not await. A transaction opened inside
   * `work` joins the outer one.
   */
  readonly transaction: <Value>(mode: 'read' | 'write', work: () => Value) => Value;
  /** Optional: release the connection. Its owner calls it; the file system and the journal borrow the connection and never close it. */
  readonly close?: () => void;
}

/** A `node:sqlite` file as a connection: WAL, full sync, `BEGIN IMMEDIATE` for writes. Loaded without a static import so other runtimes can bundle this module. */
export function openNodeConnection(filename: string): SqliteConnection {
  const sqlite = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.('node:sqlite') as { DatabaseSync: typeof DatabaseSync } | undefined;
  if (!sqlite) throw new Error('A filename needs Node.js with node:sqlite; pass a connection on other runtimes');
  const db = new sqlite.DatabaseSync(filename);
  try { db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;'); } catch (error) { db.close(); throw error; }
  return {
    exec: sql => { db.exec(sql); },
    run: (sql, ...params) => { db.prepare(sql).run(...params); },
    get: <Row extends object>(sql: string, ...params: SqliteValue[]) => db.prepare(sql).get(...params) as Row | undefined,
    all: <Row extends object>(sql: string, ...params: SqliteValue[]) => db.prepare(sql).all(...params) as Row[],
    // A transaction opened inside another one joins it: the outer one commits or rolls back everything.
    transaction: (mode, work) => {
      if (db.isTransaction) return work();
      db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => { db.close(); },
  };
}

