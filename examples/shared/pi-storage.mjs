// Host code: Pi's durable SQLite storage on the host's SQLite settings. Pi's `openNodeSqliteStorage` always sets WAL and
// `synchronous = NORMAL` (fine on local disk, unsafe on a network file system); its public adapter takes an open `node:sqlite`
// database instead, so the host opens the file with `openNodeDatabase` (the one place v4 sets pragmas, `@boring/files/sqlite`)
// and hands it over. Nothing of Pi is copied or patched; the storage and its database stay Pi's (`harness.close` closes them).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { NodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openNodeDatabase } from '@boring/files/sqlite';

/** `settings`: a preset of `sqliteSettings` (`localDisk` by default, `networkFilesystem` on EFS) or partial `SqliteSettings`. */
export async function openPiStorage(filename, settings = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const database = new NodeSqliteDatabase(openNodeDatabase(filename, settings));
  try { return await SqliteStorage.open(database); } catch (error) { await database.close().catch(() => {}); throw error; }
}
