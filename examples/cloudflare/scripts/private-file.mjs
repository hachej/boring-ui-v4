// Files that hold a credential are private from their first byte: created with mode 0600, never written with the default mode and
// chmod-ed afterwards.
import { closeSync, constants, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Create `path` with mode 0600 and write `data`. Fails with EEXIST when it already exists (no truncation, no symlink followed). */
export function createPrivateFile(path, data) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeSync(fd, data); } finally { closeSync(fd); }
}

/** Replace `path` atomically: write a fresh 0600 file next to it, then rename it over the old one. Readers see old or new, never part. */
export function writePrivateFile(path, data) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try { createPrivateFile(temp, data); renameSync(temp, path); } catch (error) { rmSync(temp, { force: true }); throw error; }
}
