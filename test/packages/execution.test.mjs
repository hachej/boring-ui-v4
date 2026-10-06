import { createGitRepository } from '@boring/files/git';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createVirtualWorkspace } from '@boring/execution/virtual';
import { createVirtualGitFs, installVirtualGitCommand } from '@boring/execution/virtual-git';
import { BACKGROUND_CONTEXT as context, withCancel } from '@earendil-works/chord/context';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { Harness, MemoryStorage, createRegistry, defineExtension, ToolResultEntry } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { createWriteTool, createReadTool, createEditTool } from '@earendil-works/pi-durable/tools';
import git from 'isomorphic-git';
import { admitDocumentTool } from '../fixtures/native-document.mjs';
import { runCaptured } from '../../scripts/run-captured.mjs';

const author = { name: 'Fictional author', email: 'author@example.invalid', timestamp: 1, timezoneOffset: 0 };
const acquire = (workspace, cwd = '/repo') => workspace.acquire({ operationId: 'fixture-acquisition', input: { cwd } }, context);
function fixture(t, files = { '/repo/note.txt': 'original\n' }) {
  const workspace = createVirtualWorkspace({ providerId: 'fictional-scratch', files });
  t.after(() => workspace.dispose()); return workspace;
}

test('native file access, direct Bash and Git share one view and preserve binary bytes', async t => {
  const workspace = fixture(t);
  const { environment: env } = await acquire(workspace);
  const shell = workspace.createBash({ cwd: '/repo' });
  getOrThrow(await env.writeFile('note.txt', 'native bytes\n', context));
  assert.equal((await shell.exec('cat note.txt')).stdout, 'native bytes\n');
  assert.equal((await shell.exec('printf "shell bytes\\n" > note.txt')).exitCode, 0);
  assert.equal(getOrThrow(await env.readTextFile('note.txt', context)), 'shell bytes\n');
  const bytes = new Uint8Array([0, 255, 128]);
  getOrThrow(await env.writeFile('binary', bytes, context)); bytes[0] = 33;
  const read = getOrThrow(await env.readBinaryFile('binary', context)); read[1] = 0;
  assert.deepEqual(await workspace.filesystem.readFileBuffer('/repo/binary'), new Uint8Array([0, 255, 128]));
  const repo = { fs: createVirtualGitFs(workspace.filesystem), dir: '/repo' };
  await git.init({ ...repo, defaultBranch: 'main' });
  await git.add({ ...repo, filepath: '.' });
  const commit = await git.commit({ ...repo, author, message: 'Fictional shared view' });
  assert.equal((await git.log(repo))[0].oid, commit);
  assert.deepEqual((await git.readBlob({ ...repo, oid: commit, filepath: 'binary' })).blob, new Uint8Array([0, 255, 128]));
  getOrThrow(await env.writeFile('note.txt', 'changed', context));
  assert.equal(await git.status({ ...repo, filepath: 'note.txt' }), '*modified');
});

test('concurrent cwd facades share identity without sharing cwd or cleanup', async t => {
  const workspace = fixture(t, { '/a/note': 'a', '/b/note': 'b' });
  const [left, right] = await Promise.all([acquire(workspace, '/a'), acquire(workspace, '/b')]);
  assert.equal(left.environment.id, right.environment.id);
  assert.deepEqual(left.identity, right.identity);
  assert.deepEqual(await Promise.all([left.environment.readTextFile('note', context), right.environment.readTextFile('note', context)]), [{ ok: true, value: 'a' }, { ok: true, value: 'b' }]);
  left.environment.cwd = '/b';
  right.environment.cwd = '/a';
  assert.equal(getOrThrow(await left.environment.readTextFile('note', context)), 'b');
  await left.release(context); await left.release(context);
  assert.equal((await left.environment.writeFile('note', 'must not write', context)).error.code, 'invalid');
  assert.equal(getOrThrow(await right.environment.readTextFile('note', context)), 'a');
  workspace.dispose();
  assert.equal((await right.environment.readTextFile('note', context)).error.code, 'invalid');
  await assert.rejects(acquire(workspace, '/a'), /disposed/);
});

test('separate workspaces capture mutable seed bytes and retain distinct namespaces', async t => {
  const bytes = new Uint8Array([1, 2]);
  const first = fixture(t, { '/repo/data': bytes }), second = fixture(t, { '/repo/data': bytes });
  bytes[0] = 9;
  const a = (await acquire(first)).environment, b = (await acquire(second)).environment;
  assert.notEqual(a.id, b.id);
  getOrThrow(await a.writeFile('data', new Uint8Array([3]), context));
  assert.deepEqual(getOrThrow(await b.readBinaryFile('data', context)), new Uint8Array([1, 2]));
});

test('native paths preserve symlink identity, canonical targets and LF termination', async t => {
  const workspace = fixture(t, { '/repo/lines': 'a\r\nb\nlast', '/repo/empty': '' });
  await workspace.filesystem.symlink('/repo/lines', '/repo/link');
  const env = (await acquire(workspace)).environment;
  assert.equal(getOrThrow(await env.fileInfo('link', context)).kind, 'symlink');
  assert.equal(getOrThrow(await env.canonicalPath('link', context)), '/repo/lines');
  assert.equal(getOrThrow(await env.absolutePath('../repo/lines', context)), '/repo/lines');
  assert.equal(getOrThrow(await env.joinPath(['a', '..', 'b'], context)), 'b');
  assert.ok(getOrThrow(await env.listDir('.', context)).some(item => item.name === 'link' && item.kind === 'symlink'));
  const reader = getOrThrow(await env.openTextLineReader('lines', context));
  assert.deepEqual(getOrThrow(await reader.readLine(context)), { text: 'a\r', terminated: true });
  assert.deepEqual(getOrThrow(await reader.readLine(context)), { text: 'b', terminated: true });
  assert.deepEqual(getOrThrow(await reader.readLine(context)), { text: 'last', terminated: false });
  assert.equal(getOrThrow(await reader.readLine(context)), undefined);
  await reader.close(context);
  assert.equal((await reader.readLine(context)).error.code, 'invalid');
  assert.deepEqual(getOrThrow(await env.readTextLines('lines', { maxLines: 2 }, context)), ['a\r', 'b']);
  assert.deepEqual(getOrThrow(await env.readTextLines('missing', { maxLines: 0 }, context)), []);
  assert.deepEqual(getOrThrow(await env.readTextLines('empty', undefined, context)), []);
  getOrThrow(await env.writeFile('terminated', 'one\n', context));
  assert.deepEqual(getOrThrow(await env.readTextLines('terminated', undefined, context)), ['one']);
  assert.equal((await env.fileInfo('missing', context)).error.code, 'not_found');
  assert.equal((await env.readTextFile('.', context)).error.code, 'is_directory');
});

test('temporary files are distinct and private; ordinary scratch operations need no receipts', async t => {
  const workspace = fixture(t), env = (await acquire(workspace)).environment;
  const paths = await Promise.all(Array.from({ length: 12 }, () => env.createTempFile({ prefix: 'fixture-', suffix: '.bin' }, context)));
  assert.equal(new Set(paths.map(getOrThrow)).size, 12);
  for (const result of paths) assert.equal((await workspace.filesystem.stat(getOrThrow(result))).mode & 0o777, 0o600);
  const directory = getOrThrow(await env.createTempDir('fixture-', context));
  assert.equal((await workspace.filesystem.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await env.createTempFile({ prefix: '../escape' }, context)).error.code, 'invalid');
  getOrThrow(await env.createDir('nested/child', { recursive: true }, context));
  getOrThrow(await env.writeFile('nested/child/data', 'a', context));
  getOrThrow(await env.appendFile('nested/child/data', 'b', context));
  assert.equal(getOrThrow(await env.readTextFile('nested/child/data', context)), 'ab');
  getOrThrow(await env.remove('nested', { recursive: true }, context));
  assert.equal(getOrThrow(await env.exists('nested', context)), false);
});

test('append and removal follow directory aliases without replacing symlink targets', async t => {
  const workspace = fixture(t, { '/repo/target/value': 'original' });
  await workspace.filesystem.symlink('/repo/target', '/repo/alias');
  await workspace.filesystem.symlink('target/value', '/repo/link');
  const env = (await acquire(workspace)).environment;
  getOrThrow(await env.appendFile('link', '-one', context));
  getOrThrow(await env.appendFile('alias/value', '-two', context));
  assert.equal(getOrThrow(await env.readTextFile('target/value', context)), 'original-one-two');
  const fs = createVirtualGitFs(workspace.filesystem).promises;
  await fs.writeFile('/repo/target/git-file', 'remove');
  await fs.unlink('/repo/alias/git-file');
  assert.equal(await workspace.filesystem.exists('/repo/target/git-file'), false);
  getOrThrow(await env.remove('alias/value', undefined, context));
  assert.equal(await workspace.filesystem.exists('/repo/target/value'), false);
  assert.equal(getOrThrow(await env.fileInfo('link', context)).kind, 'symlink');
});

test('unqualified rename/truncate/flush refuse before effects and cannot clobber competing writes', async t => {
  const workspace = fixture(t, { '/repo/source': 'AAAA', '/repo/directory/child': 'kept' });
  const env = (await acquire(workspace)).environment;
  assert.equal((await env.renameFile('source', 'directory', context)).error.code, 'not_supported');
  assert.equal(getOrThrow(await env.fileInfo('directory', context)).kind, 'directory');
  assert.equal(getOrThrow(await env.readTextFile('directory/child', context)), 'kept');
  const [truncated, written] = await Promise.all([env.truncateFile('source', 2, context), env.writeFile('source', 'ZZZZ', context)]);
  assert.equal(truncated.error.code, 'not_supported'); assert.equal(written.ok, true);
  assert.equal(getOrThrow(await env.readTextFile('source', context)), 'ZZZZ');
  assert.equal((await env.flushFile('source', context)).error.code, 'not_supported');
});

test('native shell options work with buffered output so the stock bash tool runs; direct Bash stays useful', async t => {
  const workspace = fixture(t), env = (await acquire(workspace)).environment;
  const chunks = [];
  // Output arrives once, after the command ends; spill thresholds are accepted and nothing is spilled.
  assert.deepEqual(getOrThrow(await env.exec('echo out; echo diagnostic >&2', { onOutput: text => chunks.push(text), spill: { afterBytes: 1, afterLines: 1 }, timeout: 5 }, context)), { exitCode: 0 });
  assert.deepEqual(chunks, ['out\ndiagnostic\n']);
  assert.equal((await env.exec('sleep 5', { timeout: 0.05 }, context)).error.code, 'timeout');
  assert.equal((await env.exec('echo x', { onOutput: () => { throw new Error('listener failed'); } }, context)).error.code, 'callback_error');
  assert.equal(getOrThrow(await env.readTextFile('note.txt', context)), 'original\n');
  assert.deepEqual(getOrThrow(await env.exec('echo changed > note.txt', undefined, context)), { exitCode: 0 });
  const output = await workspace.createBash({ cwd: '/repo' }).exec('cat note.txt; echo diagnostic >&2');
  assert.equal(output.stdout, 'changed\n'); assert.equal(output.stderr, 'diagnostic\n');
  const cancelled = withCancel(context); cancelled.cancel();
  assert.equal((await env.writeFile('note.txt', 'denied', cancelled.context)).error.code, 'aborted');
  assert.equal((await env.exec('echo denied > note.txt', undefined, cancelled.context)).error.code, 'aborted');
  assert.equal(getOrThrow(await env.readTextFile('note.txt', context)), 'changed\n');
});

test('Git I/O captures bytes, preserves symlinks and refuses wrong deletion kinds', async t => {
  const workspace = fixture(t), fs = createVirtualGitFs(workspace.filesystem).promises;
  const bytes = new Uint8Array([0, 255]); await fs.writeFile('/repo/binary', bytes); bytes[0] = 7;
  assert.deepEqual(await fs.readFile('/repo/binary'), new Uint8Array([0, 255]));
  await fs.mkdir('/repo/empty');
  await assert.rejects(fs.unlink('/repo/empty'), { code: 'EISDIR' });
  await assert.rejects(fs.rmdir('/repo/binary'), { code: 'ENOTDIR' });
  await fs.symlink('binary', '/repo/link');
  assert.equal((await fs.lstat('/repo/link')).isSymbolicLink(), true);
  assert.equal(await fs.readlink('/repo/link'), 'binary');
  await fs.unlink('/repo/link');
  assert.deepEqual(await fs.readFile('/repo/binary'), new Uint8Array([0, 255]));
  await assert.rejects(fs.readFile('/repo/missing'), { code: 'ENOENT' });
});

test('installed local Git commands share Bash changes, direct history and branch checkout', async t => {
  const workspace = fixture(t), env = (await acquire(workspace)).environment;
  const shell = workspace.createBash({ cwd: '/repo' });
  installVirtualGitCommand({ bash: shell, repository: createGitRepository({ fs: createVirtualGitFs(workspace.filesystem), directory: '/repo', author, authorize: () => true }) });
  for (const command of ['git init', 'git add note.txt', 'git commit -m initial', 'git branch feature', 'git checkout feature', 'echo feature > note.txt', 'git add note.txt', 'git commit -m feature']) {
    const result = await shell.exec(command); assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
  }
  assert.equal(JSON.parse((await shell.exec('git log')).stdout).length, 2);
  assert.equal(getOrThrow(await env.readTextFile('note.txt', context)), 'feature\n');
  assert.equal((await shell.exec('git checkout main')).exitCode, 0);
  assert.equal(getOrThrow(await env.readTextFile('note.txt', context)), 'original\n');
  assert.equal(JSON.parse((await shell.exec('git status')).stdout)[0][2], 1);
  for (const command of ['git push', 'git reset --hard', 'git commit --amend', 'git checkout main extra']) assert.equal((await shell.exec(command)).exitCode, 126, command);
});

test('actual native read/write/edit ToolTasks execute against the virtual environment', { timeout: 15000 }, async t => {
  const workspace = fixture(t), leases = [];
  const registry = createRegistry(); registry.install(defineExtension({ name: 'fictional.virtual-files', tools: [createWriteTool(), createReadTool(), createEditTool()] }));
  const harness = await Harness.open(new MemoryStorage(), { registry, models: createModels(), env: async () => { const lease = await acquire(workspace); leases.push(lease); return lease.environment; } }, context);
  t.after(async () => { await harness.close(context); for (const lease of leases) await lease.release(context); });
  const conversation = await harness.root(context);
  for (const [name, args] of [['write', { path: 'created.txt', content: 'native tool text' }], ['edit', { path: 'created.txt', edits: [{ oldText: 'tool', newText: 'edited' }] }], ['read', { path: 'created.txt' }]]) {
    const taskId = await admitDocumentTool(conversation, args, name);
    const terminal = await harness.waitForTask(taskId, context);
    assert.equal(terminal.state.outcome.status, 'completed');
    const entry = await conversation.commit(tx => tx.entry(ToolResultEntry, terminal.state.outcome.result.entryId), context);
    assert.equal(entry.model[0].isError, false);
    if (name === 'read') assert.match(entry.model[0].content[0].text, /native edited text/);
  }
  assert.equal((await workspace.createBash({ cwd: '/repo' }).exec('cat created.txt')).stdout, 'native edited text');
});

test('virtual commands never fall back to a native process or default network transport', () => {
  const result = runCaptured(process.execPath, [new URL('../fixtures/virtual-no-fallback.mjs', import.meta.url).pathname], { timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /native calls=0; network calls=0/);
});

test('native, Bash and Git mutations follow shared directory and final symlinks', async t => {
  const workspace = fixture(t), backing = workspace.filesystem;
  await backing.symlink('/repo', '/alias');
  await backing.symlink('note.txt', '/repo/link');
  await backing.symlink('new.txt', '/repo/dangling');
  const env = (await acquire(workspace, '/alias')).environment;
  getOrThrow(await env.writeFile('link', 'native', context));
  assert.equal(await backing.readFile('/repo/note.txt'), 'native');
  assert.equal((await backing.lstat('/repo/link')).isSymbolicLink, true);
  const shell = workspace.createBash({ cwd: '/alias' });
  assert.equal((await shell.exec('printf shell > link; printf created > dangling')).exitCode, 0);
  assert.equal(await backing.readFile('/repo/note.txt'), 'shell');
  assert.equal(await backing.readFile('/repo/new.txt'), 'created');
  assert.equal((await backing.lstat('/repo/dangling')).isSymbolicLink, true);
  getOrThrow(await env.createDir('nested/child', { recursive: true }, context));
  assert.equal((await backing.stat('/repo/nested/child')).isDirectory, true);
  assert.equal((await env.createDir('note.txt/child', { recursive: true }, context)).error.code, 'not_directory');
  const fs = createVirtualGitFs(backing).promises;
  await fs.writeFile('/alias/link', 'git');
  assert.equal(await backing.readFile('/repo/note.txt'), 'git');
  await fs.mkdir('/alias/git-dir');
  await fs.rmdir('/alias/git-dir');
  await fs.unlink('/alias/dangling');
  assert.equal(await backing.readFile('/repo/new.txt'), 'created');
  await backing.createExclusive('/alias/private', { mode: 0o600, directory: false });
  assert.equal((await backing.stat('/repo/private')).mode & 0o777, 0o600);
  await assert.rejects(backing.createExclusive('/alias/private', { mode: 0o600, directory: false }), /EEXIST/);
  await backing.symlink('loop-b', '/repo/loop-a');
  await backing.symlink('loop-a', '/repo/loop-b');
  await assert.rejects(backing.writeFile('/alias/loop-a', 'never'), /ELOOP/);
  await assert.rejects(backing.mv('/repo/note.txt', '/repo/nested'), /ENOTSUP/);
  assert.equal(await backing.readFile('/repo/note.txt'), 'git');
});

test('mutations refuse directory corruption and preserve copy destination aliases', async t => {
  const workspace = fixture(t, { '/repo/nested/child': 'retained', '/repo/source': 'copied', '/repo/target': 'original' });
  const env = (await acquire(workspace)).environment, fs = workspace.filesystem;
  for (const method of ['writeFile', 'appendFile']) {
    assert.equal((await env[method]('nested', 'corruption', context)).error.code, 'is_directory');
    assert.equal(getOrThrow(await env.fileInfo('nested', context)).kind, 'directory');
    assert.equal(getOrThrow(await env.readTextFile('nested/child', context)), 'retained');
  }
  await fs.symlink('target', '/repo/link');
  assert.equal((await env.createDir('link', { recursive: true }, context)).error.code, 'not_directory');
  await fs.cp('/repo/source', '/repo/link');
  assert.equal((await fs.lstat('/repo/link')).isSymbolicLink, true);
  assert.equal(await fs.readFile('/repo/target'), 'copied');
  await assert.rejects(fs.cp('/repo/nested', '/repo/new', { recursive: true }), /ENOTSUP/);
  assert.equal(await fs.exists('/repo/new'), false);
});

test('virtual SQLite repository: seeded, git-enabled native env over the SQLite file system; every write lands in SQLite at once and a reopen sees changes, deletions and empty folders (node:sqlite here; a browser passes openBrowserSqliteConnection)', async t => {
  const { openVirtualRepository } = await import('@boring/execution/virtual-sqlite');
  const { openNodeConnection } = await import('@boring/files/sqlite');
  const { openSqliteFileSystem } = await import('@boring/files/sqlite-filesystem');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'boring-virtual-sqlite-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let db;
  const open = () => {
    db = openNodeConnection(join(directory, 'workspace.sqlite'));
    const fs = openSqliteFileSystem({ connection: db, workspace: 'fictional', cwd: '/repo' });
    return openVirtualRepository({ fs, root: '/repo', seed: { 'README.md': '# Fictional\n', 'src/a.txt': 'a\n' }, seedMessage: 'Seed', author: { name: 'Fictional', email: 'f@example.invalid' }, context });
  };
  // Everything is read through Pi's native env; its shell has git bound to the same repository.
  const sh = async (repo, command) => { let output = ''; const result = getOrThrow(await repo.env.exec(command, { onOutput: text => { output += text; } }, context)); return { output, exitCode: result.exitCode }; };
  const listed = async repo => (await sh(repo, 'find . -type f -not -path "./.git/*" | sort')).output.trim().split('\n');
  let repo = await open();
  try {
    assert.deepEqual(await listed(repo), ['./README.md', './src/a.txt']);
    assert.equal(getOrThrow(await repo.env.readTextFile('README.md', context)), '# Fictional\n');
    assert.deepEqual((await repo.repository.log()).map(entry => entry.commit.message.trim()), ['Seed']);
    const changed = await sh(repo, 'echo changed > src/a.txt && mkdir -p empty/inner && rm README.md && git log');
    assert.equal(changed.exitCode, 0); assert.match(changed.output, /Seed/);
    assert.equal((await sh(repo, 'git branch')).output, 'main\n');
    // Already in SQLite, before any close: the rows are the files.
    const rows = db.all("SELECT path, kind FROM boring_workspace_files WHERE workspace = 'fictional' AND path NOT LIKE '/repo/.git%' ORDER BY path").map(row => `${row.kind} ${row.path}`);
    assert.deepEqual(rows, ['directory /repo', 'directory /repo/empty', 'directory /repo/empty/inner', 'directory /repo/src', 'file /repo/src/a.txt']);
    assert.equal(new TextDecoder().decode(db.get("SELECT bytes FROM boring_workspace_files WHERE path = '/repo/src/a.txt'").bytes), 'changed\n');
    assert.equal((await sh(repo, 'ln -s src/a.txt link')).exitCode, 1, 'links are refused, not faked');
    await repo.close(); db.close?.();
    repo = await open();
    assert.deepEqual(await listed(repo), ['./src/a.txt'], 'the deletion is restored');
    assert.equal(getOrThrow(await repo.env.readTextFile('src/a.txt', context)), 'changed\n');
    assert.equal((await sh(repo, 'ls empty')).output, 'inner\n', 'the empty folder is restored');
    assert.deepEqual((await repo.repository.log()).map(entry => entry.commit.message.trim()), ['Seed'], 'history is restored, not re-seeded');
    assert.equal((await sh(repo, 'git status')).exitCode, 0);
  } finally { await repo.close(); db.close?.(); }
});
