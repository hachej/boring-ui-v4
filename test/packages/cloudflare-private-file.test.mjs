// The ChatGPT sign-in script of the Cloudflare recipe writes the credential and the device id private from their first byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateFile, writePrivateFile } from '../../examples/cloudflare/scripts/private-file.mjs';

const mode = path => statSync(path).mode & 0o777;

test('private files are created 0600 even under a permissive umask, and never replaced through createPrivateFile', t => {
  const directory = mkdtempSync(join(tmpdir(), 'private-file-'));
  const previous = process.umask(0o000);
  t.after(() => { process.umask(previous); rmSync(directory, { recursive: true, force: true }); });
  const device = join(directory, 'credential.json.device-id');
  createPrivateFile(device, 'fictional-device');
  assert.equal(mode(device), 0o600);
  assert.throws(() => createPrivateFile(device, 'other'), { code: 'EEXIST' });
  assert.equal(readFileSync(device, 'utf8'), 'fictional-device');
  // A planted symlink is not followed.
  const target = join(directory, 'elsewhere');
  writeFileSync(target, 'untouched');
  symlinkSync(target, join(directory, 'link'));
  assert.throws(() => createPrivateFile(join(directory, 'link'), 'x'), { code: 'EEXIST' });
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
});

test('writePrivateFile replaces a world-readable file atomically with a 0600 one and leaves no temp file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'private-file-'));
  const previous = process.umask(0o000);
  t.after(() => { process.umask(previous); rmSync(directory, { recursive: true, force: true }); });
  const credential = join(directory, 'credential.json');
  writeFileSync(credential, '{"old":true}', { mode: 0o644 });
  assert.equal(mode(credential), 0o644);
  writePrivateFile(credential, '{"fictional":true}');
  assert.equal(mode(credential), 0o600);
  assert.equal(readFileSync(credential, 'utf8'), '{"fictional":true}');
  assert.deepEqual(readdirSync(directory), ['credential.json']);
});

test('the sign-in script writes both files only through the private helpers', () => {
  const source = readFileSync(new URL('../../examples/cloudflare/scripts/chatgpt-login.mjs', import.meta.url), 'utf8');
  assert.match(source, /createPrivateFile\(deviceFile,/);
  assert.match(source, /writePrivateFile\(out,/);
  assert.doesNotMatch(source, /chmodSync|writeFileSync\((out|deviceFile)\b/);
});
