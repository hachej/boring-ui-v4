import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, AssistantEntry, ToolTask, ToolResultEntry, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeConnection } from '@boring/files/sqlite';
import { openSqliteFileSystem } from '@boring/files/sqlite-filesystem';
import { lastReadRevisions } from '@boring/agent/file-guard';
import { createCanvasTools } from '../../examples/shared/canvas-tools.mjs';
import { openSqliteWorkspaces } from '../../examples/shared/sqlite-workspaces.mjs';

const access = { principalId: 'fictional-agent', initiatorId: 'alice', scopeId: 'fictional-canvas' };
const target = { resource: { providerId: 'canvas-test', path: 'board.tldraw' }, view: { kind: 'published' } };
const shape = id => ({ id, kind: 'rectangle', text: id, x: 0, y: 0 });
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'boring-canvas-publication-'));
  const owner = openSqliteWorkspaces({ filename: join(directory, 'files.sqlite'), providerId: target.resource.providerId, authorize: () => true });
  const actual = owner.workspace(access.scopeId);
  const control = { publish: (request, granted) => actual.publication.publish(request, granted) };
  const files = { ...actual, publication: { ...actual.publication, publish: (request, granted) => control.publish(request, granted) } };
  const registry = createRegistry();
  const tools = createCanvasTools({ workspace: { files, root: '/workspace', access } });
  assert.equal(tools.find(tool => tool.name === 'add_canvas_shapes').replay, 'unsafe');
  registry.install(defineExtension({ name: 'fictional.canvas-publication', docs: [lastReadRevisions], tools }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'native.sqlite')), { registry, models: createModels() }, context);
  t.after(async () => { await harness.close(context); owner.close(); rmSync(directory, { recursive: true, force: true }); });
  const conversation = await harness.root(context);
  async function run(name, args = {}) {
    const id = await conversation.commit(async tx => {
      const entry = await tx.appendEntry(AssistantEntry, conversation.id, { model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call', name, arguments: args }], api: 'fixture', provider: 'fixture', model: 'fictional-no-model', timestamp: 1, stopReason: 'toolUse',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] });
      return tx.createTask(ToolTask, { assistant: entry.id, callId: 'call' }, { ownership: { kind: 'conversation' } });
    }, context);
    const terminal = await harness.waitForTask(id, context);
    assert.equal(terminal.state.outcome.status, 'completed', JSON.stringify(terminal.state));
    const entry = await conversation.commit(tx => tx.entry(ToolResultEntry, terminal.state.outcome.result.entryId), context);
    const result = entry.model[0];
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  }
  const baseline = async () => (await harness.snapshot(lastReadRevisions, conversation.id, context))?.revisions['canvas-test:board.tldraw'];
  const read = () => actual.read({ target, revision: { kind: 'latest' } }, access);
  return { actual, control, run, baseline, read, directory };
}

test('canvas tool acknowledges its own receipt and refuses a later unread edit after an intervening human publication', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('add_canvas_shapes', { shapes: [shape('first')] })).kind, 'saved');
  let firstReceipt, humanReceipt;
  f.control.publish = async (request, granted) => {
    const result = await f.actual.publication.publish(request, granted);
    assert.equal(result.kind, 'committed'); firstReceipt = result.receipt;
    const change = request.changes[0], document = JSON.parse(new TextDecoder().decode(change.bytes));
    document.store['shape:first'].x = 999;
    const human = await f.actual.publication.publish({ operationId: 'fictional-human-between-commit-and-ack', atomicity: 'all-or-nothing', changes: [{ kind: 'replace', target: result.receipt.changes[0].after,
      mediaType: change.mediaType, bytes: new TextEncoder().encode(JSON.stringify(document)) }] }, { ...access, principalId: 'fictional-human' });
    assert.equal(human.kind, 'committed'); humanReceipt = human.receipt;
    return result;
  };
  const added = await f.run('add_canvas_shapes', { shapes: [shape('second')] });
  assert.equal(added.kind, 'saved');
  assert.equal(added.revision, firstReceipt.changes[0].after.revision);
  assert.notEqual(added.revision, humanReceipt.changes[0].after.revision);
  assert.equal(added.shapes.find(shape => shape.id === 'first').x, 0);
  assert.equal(await f.baseline(), added.revision);
  f.control.publish = (request, granted) => f.actual.publication.publish(request, granted);
  assert.equal((await f.run('remove_canvas_shapes', { ids: ['first'] })).kind, 'conflict');
  const saved = await f.read();
  assert.equal(saved.snapshot.ref.revision, humanReceipt.changes[0].after.revision);
  assert.equal(JSON.parse(new TextDecoder().decode(saved.snapshot.bytes)).store['shape:first'].x, 999);
  const read = await f.run('read_canvas');
  assert.equal(read.shapes.find(shape => shape.id === 'first').x, 999);
  assert.equal(await f.baseline(), humanReceipt.changes[0].after.revision);
  assert.equal((await f.run('remove_canvas_shapes', { ids: ['first'] })).kind, 'saved');
});

test('canvas creation, replacement, read, removal and recreation use the exact published revisions', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.run('read_canvas'), { kind: 'missing', shapes: [] });
  assert.equal(await f.baseline(), undefined);
  const created = await f.run('add_canvas_shapes', { shapes: [shape('first')] });
  assert.equal(created.kind, 'saved');
  assert.equal(created.revision, (await f.read()).snapshot.ref.revision);
  assert.equal(await f.baseline(), created.revision);
  const replaced = await f.run('add_canvas_shapes', { shapes: [shape('second')] });
  assert.equal(replaced.kind, 'saved'); assert.notEqual(replaced.revision, created.revision);
  assert.equal(await f.baseline(), replaced.revision);
  assert.equal((await f.run('read_canvas')).shapes.length, 2);
  const removed = await f.run('remove_canvas_shapes', { ids: ['first'] });
  assert.equal(removed.kind, 'saved'); assert.deepEqual(removed.shapes.map(shape => shape.id), ['second']);
  assert.equal(await f.baseline(), removed.revision);
  const connection = openNodeConnection(join(f.directory, 'files.sqlite'));
  try {
    const fs = openSqliteFileSystem({ connection, workspace: access.scopeId, cwd: '/workspace' });
    assert.equal((await fs.remove('board.tldraw', {}, context)).ok, true);
  } finally { connection.close(); }
  assert.equal((await f.run('read_canvas')).kind, 'missing');
  const recreated = await f.run('add_canvas_shapes', { shapes: [shape('new')] });
  assert.equal(recreated.kind, 'saved');
  assert.deepEqual(recreated.shapes.map(shape => shape.id), ['new']);
  assert.equal(await f.baseline(), recreated.revision);
});

for (const kind of ['denied', 'unavailable', 'unknown', 'conflict']) test(`canvas ${kind} publication does not advance the conversation baseline`, async t => {
  const f = await fixture(t);
  const before = await f.run('add_canvas_shapes', { shapes: [shape('first')] });
  f.control.publish = async request => ({ kind, reason: 'Fictional refusal', ...(kind === 'unknown' ? { operationId: request.operationId } : kind === 'conflict' ? { current: [] } : {}) });
  assert.equal((await f.run('add_canvas_shapes', { shapes: [shape('second')] })).kind, kind);
  assert.equal(await f.baseline(), before.revision);
  assert.equal((await f.read()).snapshot.ref.revision, before.revision);
});

const mismatches = {
  malformed: result => { delete result.receipt; },
  revision: result => { delete result.receipt.changes[0].after.revision; },
  beforeTarget: result => { result.receipt.changes[0].before.resource.path += '.other'; },
  operation: result => { result.receipt.operationId += '-other'; },
  digest: result => { result.receipt.argumentDigest = '0'.repeat(64); },
  scope: result => { result.receipt.scopeId += '-other'; },
  principal: result => { result.receipt.principalId += '-other'; },
  initiator: result => { result.receipt.initiatorId += '-other'; },
  count: result => { result.receipt.changes.push(structuredClone(result.receipt.changes[0])); },
  target: result => { result.receipt.changes[0].after.resource.path += '.other'; },
  provider: result => { result.receipt.changes[0].after.resource.providerId += '-other'; },
  view: result => { result.receipt.changes[0].after.view = { kind: 'working', viewId: 'other' }; },
  before: result => { result.receipt.changes[0].before.revision += '-other'; },
  kind: result => { result.receipt.changes[0].kind = 'create'; result.receipt.changes[0].before = null; },
};
for (const [name, alter] of Object.entries(mismatches)) test(`canvas ${name} acknowledgement leaves the committed write unconfirmed and preserves the prior baseline`, async t => {
  const f = await fixture(t);
  const before = await f.run('add_canvas_shapes', { shapes: [shape('first')] });
  let operationId;
  f.control.publish = async (request, granted) => {
    operationId = request.operationId;
    const result = structuredClone(await f.actual.publication.publish(request, granted));
    assert.equal(result.kind, 'committed'); alter(result); return result;
  };
  const result = await f.run('add_canvas_shapes', { shapes: [shape('second')] });
  assert.equal(result.kind, 'unknown');
  assert.equal(result.operationId, operationId);
  assert.equal(await f.baseline(), before.revision);
  assert.notEqual((await f.read()).snapshot.ref.revision, before.revision);
  assert.equal((await f.run('remove_canvas_shapes', { ids: ['first'] })).kind, 'conflict');
});

test('a create acknowledgement claiming replacement remains unconfirmed without recording an unread baseline', async t => {
  const f = await fixture(t);
  f.control.publish = async (request, granted) => {
    const result = structuredClone(await f.actual.publication.publish(request, granted));
    assert.equal(result.kind, 'committed');
    result.receipt.changes[0].kind = 'replace';
    result.receipt.changes[0].before = { ...structuredClone(result.receipt.changes[0].after), revision: 'unrelated-before' };
    return result;
  };
  assert.equal((await f.run('add_canvas_shapes', { shapes: [shape('first')] })).kind, 'unknown');
  assert.equal(await f.baseline(), undefined);
  assert.equal((await f.run('add_canvas_shapes', { shapes: [shape('second')] })).kind, 'conflict');
});
