import assert from 'node:assert/strict';
import test from 'node:test';
import { Harness, MemoryStorage, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import { attachHarness } from '@boring/agent';
import { createFileGuard } from '@boring/agent/file-guard';
import { openNodeConnection } from '@boring/files/sqlite';
import { createWorkspaceJournal } from '@boring/files/journal';
import { createWorkspaceProvider } from '@boring/files/workspace';
import { openSqliteWorkspaces } from '../../examples/shared/sqlite-workspaces.mjs';
import { admitDocumentTool, createSaveNoteTool, documentToolResult, toolResultText } from '../fixtures/native-document.mjs';

const target = { resource: { providerId: 'documents', path: 'notes.md' }, view: { kind: 'published' } };
const access = { principalId: 'editor', initiatorId: 'alice', scopeId: 'fictional-project' };

test('borrowed Harness executes a native publishing tool with actual publication and survives independent detaches', { timeout: 15000 }, async t => {
  let authorized = true;
  const provider = openSqliteWorkspaces({ filename: ':memory:', providerId: 'documents', authorize: () => authorized });
  const tool = createSaveNoteTool({ target, publisher: provider.publication, operationNamespace: 'fixture-runtime-v1', replay: 'safe', resolveAccess: api => { assert.equal(api.env, undefined); return access; } });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'fixture.document', tools: [tool] }));
  const harness = await Harness.open(new MemoryStorage(), { registry, models: createModels() }, context);
  t.after(async () => { await harness.close(context); provider.close(); });
  const first = attachHarness({ harness }), second = attachHarness({ harness });
  assert.equal(first.harness, harness);
  const conversation = await harness.root(context);
  const independentWatch = await conversation.watch(context);
  t.after(() => independentWatch.stop());
  const taskId = await admitDocumentTool(conversation, { text: 'Fictional notes', expected: { kind: 'absent' } });
  const saved = await documentToolResult(first.harness, conversation, taskId);
  assert.equal(saved.result.kind, 'committed');
  assert.equal(saved.result.receipt.operationId, JSON.stringify(['fixture-runtime-v1', taskId]));
  const read = await provider.read({ target, revision: { kind: 'latest' } }, access);
  assert.equal(new TextDecoder().decode(read.snapshot.bytes), 'Fictional notes');
  assert.deepEqual(await provider.reconciliation.lookup(saved.result.receipt.operationId, access), saved.result);
  await first.detach();
  await first.detach();
  const changed = Promise.withResolvers();
  independentWatch.start(() => changed.resolve());
  await conversation.configure({ instructions: 'Host still owns this conversation' }, context);
  await changed.promise;
  const staleId = await admitDocumentTool(conversation, { text: 'stale write', expected: { kind: 'revision', revision: 'stale' } });
  assert.equal((await documentToolResult(second.harness, conversation, staleId)).result.kind, 'conflict');
  authorized = false;
  const deniedId = await admitDocumentTool(conversation, { text: 'unauthorized', expected: { kind: 'revision', revision: read.snapshot.ref.revision } });
  assert.equal((await documentToolResult(harness, conversation, deniedId)).result.kind, 'denied');
  authorized = true;
  await second.detach();
  assert.equal(new TextDecoder().decode((await provider.read({ target, revision: { kind: 'latest' } }, access)).snapshot.bytes), 'Fictional notes');
  await conversation.configure({ instructions: 'Native API remains available after detach' }, context);
});

test('OptChat view: due-merging never splits, keeps the start stable and the budget; zoom reaches the whole message; stale fingerprints are rejected', async () => {
  const { OptChatLog, OptChatTree, advanceFold, emptyFold, leavesOf, renderView, zoomText } = await import('@boring/agent/memory/optchat');
  const NODE = 100, BUDGET = 1500;
  const messages = [];
  for (let i = 0; i < 120; i++) {
    messages.push({ role: 'user', content: `note ${i}: ${'word '.repeat(i % 30)}`, timestamp: i });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `ack ${i}` }], timestamp: i });
  }
  const { leaves } = leavesOf(messages);
  assert.equal(leaves.length, 240);
  // A summary for every node that is not its own text, as a compactor would have stored them.
  const build = (log, stored) => {
    const tree = new OptChatTree(log, stored, NODE);
    for (let level = 0; 2 ** level <= log.leaves.length; level++) for (let index = 0; (index + 1) * 2 ** level <= log.leaves.length; index++) {
      if (tree.text(level, index) === undefined) stored.set(`${level}:${index}`, { text: `summary ${level}:${index}`, of: log.fp(level, index) });
    }
    return tree;
  };
  const log = new OptChatLog(), stored = new Map(), tree = build((log.set(leaves), log), stored);
  const growing = new OptChatLog(), view = emptyFold(), growingTree = new OptChatTree(growing, stored, NODE);
  let previous, before;
  const shared = [];
  for (let t = 1; t <= leaves.length; t++) {
    growing.set(leaves.slice(0, t));
    advanceFold(view, growingTree, t, BUDGET);
    assert.ok(view.size <= BUDGET, `view ${view.size} B at ${t} leaves`);
    let at = 0;
    for (const part of view.parts) { assert.equal(part.index * 2 ** part.level, at, 'parts tile the log in order'); at += 2 ** part.level; }
    assert.equal(at, t);
    // Never split: every earlier part lies inside exactly one current part.
    for (const old of previous ?? []) assert.equal(view.parts.filter(part => part.index * 2 ** part.level <= old.start && old.start + old.n <= (part.index + 1) * 2 ** part.level).length, 1);
    previous = view.parts.map(part => ({ start: part.index * 2 ** part.level, n: 2 ** part.level }));
    const lines = renderView(view, growingTree).split('\n');
    if (t > 120 && before) { let same = 0; while (same < before.length && before[same] === lines[same]) same++; shared.push(same / before.length); }
    before = lines;
  }
  assert.ok(shared.reduce((sum, value) => sum + value, 0) / shared.length > 0.5, 'consecutive views share most of their start, so a provider prompt cache is reused');
  assert.equal(view.parts[0].index, 0);
  assert.ok(view.parts.length < 60 && view.parts[0].level > 2, 'old history is coarse');
  // Zoom from the first line down to a whole message: the exact leaf text.
  let line = renderView(view, growingTree).split('\n')[1], target = leaves[0].line;
  for (let depth = 0; depth < 12; depth++) {
    const [, id, n] = /^(\d+)\+(\d+)\|/.exec(line);
    if (n === '0') break;
    line = zoomText(tree, Number(id), Number(n)).split('\n')[0];
  }
  assert.equal(line, `0+0|${target}`);
  assert.equal(zoomText(tree, 3, 2), 'No line 3+2.');
  // A fork or an edit changes the content: summaries of different content are not shown.
  const edited = leaves.slice(); edited[5] = leavesOf([{ role: 'user', content: `note 5: ${'EDITED '.repeat(30)}`, timestamp: 5 }]).leaves[0];
  const editedLog = new OptChatLog(); editedLog.set(edited);
  const editedTree = new OptChatTree(editedLog, stored, NODE);
  assert.equal(tree.text(0, 5) !== undefined, true);
  assert.notEqual(editedTree.text(0, 5), tree.text(0, 5), 'the edited message never shows the old summary');
  assert.equal(editedTree.text(2, 1), undefined, 'a node over the edited message is unbuilt until rebuilt');
  assert.equal(editedTree.text(2, 2), tree.text(2, 2), 'nodes elsewhere stay valid');
});

test('OptChat memory is opt-in per conversation: the request carries the view and the current turn, the transcript is untouched, zoom reaches the exact message', { timeout: 20000 }, async t => {
  const { createOptChatMemory } = await import('@boring/agent/memory/optchat');
  const { createProvider } = await import('@earendil-works/pi-ai/models');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai/utils/event-stream');
  const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const MODEL = { id: 'scripted', name: 'Scripted', provider: 'scripted', api: 'scripted-api', baseUrl: 'https://fixture.invalid', input: ['text'], reasoning: false, contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const requests = [];
  // Answers only from what the request contains.
  const decide = messages => {
    const last = messages.at(-1), said = textOf(last);
    if (last.role === 'toolResult') return { text: `zoomed: ${said}` };
    if (/Use zoom/.test(said)) return { tool: { name: 'zoom', arguments: { id: 0, n: 1 } } };
    if (/what is my dog called/i.test(said)) return { text: `Your dog is ${/dog is called (\w+)/.exec(messages.map(textOf).join('\n'))?.[1] ?? 'unknown'}.` };
    return { text: 'Noted.' };
  };
  const stream = (_model, request) => {
    requests.push(structuredClone(request));
    const events = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    setTimeout(() => {
      const answer = decide(request.messages.filter(item => item.role !== 'system'));
      events.push({ type: 'start', partial: message });
      if (answer.tool) {
        const toolCall = { type: 'toolCall', id: `call-${requests.length}`, name: answer.tool.name, arguments: answer.tool.arguments };
        message.content.push(toolCall); message.stopReason = 'toolUse';
        events.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message }); events.push({ type: 'done', reason: 'toolUse', message });
      } else {
        message.content.push({ type: 'text', text: answer.text });
        events.push({ type: 'text_end', contentIndex: 0, content: answer.text, partial: message }); events.push({ type: 'done', reason: 'stop', message });
      }
      events.end(message);
    }, 5);
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({ id: MODEL.provider, models: [MODEL], auth: { apiKey: { name: 'keyless', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  // A second, separate model is the summarizer: the first words of what it summarizes, marked, so the view is visibly not the original text. Each call reports usage.
  const SUMMARIZER = { ...MODEL, id: 'summ', name: 'Summ', provider: 'summ', api: 'summ-api' };
  let summarizerCalls = 0;
  const summarize = (_model, request) => {
    summarizerCalls++;
    const events = createAssistantMessageEventStream();
    const lines = textOf(request.messages.findLast(item => item.role === "user")).split(/(?:Compress this message into one line|Merge these two lines into one), in at most \d+ bytes:\n/)[1].split('\n');
    const line = `~ ${lines.map(item => item.split(' ').slice(0, 6).join(' ')).join(' / ')}`;
    const message = { role: 'assistant', content: [{ type: 'text', text: line }], api: SUMMARIZER.api, provider: SUMMARIZER.provider, model: SUMMARIZER.id, timestamp: Date.now(), stopReason: 'stop',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } } };
    setTimeout(() => { events.push({ type: 'start', partial: message }); events.push({ type: 'done', reason: 'stop', message }); events.end(message); }, 20);
    return events;
  };
  models.setProvider(createProvider({ id: SUMMARIZER.provider, models: [SUMMARIZER], auth: { apiKey: { name: 'keyless', resolve: async () => ({ auth: {} }) } }, api: { stream: summarize, streamSimple: summarize } }));
  let harness;
  // The model may depend on the conversation (a host with one conversation per site picks each one's model).
  const askedFor = new Set();
  const summarizer = { model: async conversationId => { askedFor.add(String(conversationId)); return { provider: 'summ', modelId: 'summ' }; } };
  const memory = createOptChatMemory({ harness: () => harness, context, summarizer, nodeBytes: 160, viewBytes: 4000, retryMs: 20, settleTimeoutMs: 5000 });
  const plain = defineExtension({ name: 'fixture.plain', sections: [] });
  const registry = createRegistry();
  registry.install(plain); registry.install(memory.extension);
  harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
  t.after(async () => { await memory.dispose(); await harness.close(context); });
  // Watch Pi's task graph: summaries must show up as native, background, conversation-owned tasks.
  const graph = await harness.taskGraph(context);
  const nodeTasks = new Map();
  const watchGraph = value => { for (const node of Object.values(value.tasks)) if (node.kind === 'boring.memory.optchat.node') nodeTasks.set(node.id, { background: node.background, owner: node.owner, status: node.state.status }); };
  graph.subscribe(watchGraph); watchGraph(graph.value);
  t.after(() => graph.dispose());
  const conversation = await harness.root(context, { agent: { model: { provider: 'scripted', modelId: 'scripted' }, extensions: [plain], instructions: 'Be brief.' } });
  harness.resume();
  const say = async text => { await (await conversation.submit({ type: 'input', content: text }, context)).wait(context); return requests.length; };
  const sent = from => requests.slice(from).map(request => request.messages);
  const system = messages => messages.filter(message => message.role === 'system');

  await say('My dog is called Biscuit.');
  await say(`Filler one. ${'The weather is fictional and the notes are long. '.repeat(8)}`);
  let seen = requests.length;
  assert.ok(sent(0).every(messages => !JSON.stringify(messages.filter(message => message.role !== 'system')).includes('<chat>')), 'not selected: the plain transcript');

  await conversation.configure({ extensions: { add: [memory.extension] } }, context);
  for (let i = 0; i < 3; i++) await say(`Filler ${i + 2}. ${'More fictional text to summarize here. '.repeat(8)}`);
  await say('Tell me what is my dog called?');
  const answered = sent(seen).at(-1);
  assert.match(textOf(answered.findLast(message => message.role === 'user')), /^<chat>\n/, 'the view comes first in the current user message');
  assert.equal(answered.filter(message => message.role === 'user').length, 1, 'no old user message is sent');
  assert.equal(answered.filter(message => message.role === 'assistant').length, 0, 'no old assistant message is sent');
  assert.ok(!textOf(answered.findLast(message => message.role === 'user')).includes('Filler 2. The weather'), 'long old messages appear only as summaries');
  const log = await conversation.context(context);
  assert.deepEqual(system(answered), system(log.messages), 'every positional system message is kept');
  assert.ok(system(answered).some(message => /zoom\(id, n\)/.test(JSON.stringify(message.sections ?? {}))), 'the view is explained in a system section');
  assert.ok(log.messages.filter(message => message.role !== 'system').every(message => !JSON.stringify(message).includes('<chat>')), 'the stored transcript is never rewritten');
  const reply = log.messages.findLast(message => message.role === 'assistant');
  assert.equal(textOf(reply), 'Your dog is Biscuit.', 'a fact from outside the current turn came back through the view');

  seen = requests.length;
  await say('Use zoom to reopen the first message.');
  const [toolStep, resultStep] = sent(seen);
  assert.equal(toolStep.filter(message => message.role === 'assistant').length, 0);
  assert.deepEqual(resultStep.map(message => message.role).filter(role => role !== 'system'), ['user', 'assistant', 'toolResult'], 'the turn in progress stays verbatim');
  assert.equal(textOf(resultStep.at(-1)), '0+0|user: My dog is called Biscuit.', 'zoom returns the exact message');
  assert.match(await memory.date(conversation.id, 0), /^\d{4}-\d\d-\d\dT/, 'date answers with the message time');
  assert.equal(await memory.date(conversation.id, 9999), 'No message 9999.');
  // Background summary work may still be running after the last answer (Pi runs it); wait for it to drain, then account.
  for (let i = 0; i < 200 && !(await memory.stats(conversation.id)).compactor.idle; i++) await new Promise(resolve => setTimeout(resolve, 25));
  const stats = await memory.stats(conversation.id);
  assert.ok(stats.summaries > 0 && stats.view.open === 0 && stats.view.bytes <= stats.view.budget, JSON.stringify(stats.compactor));
  assert.ok(nodeTasks.size > 0 && [...nodeTasks.values()].every(task => task.background === true && task.owner === undefined), 'summaries were native background tasks owned by the conversation');
  assert.equal(stats.compactor.calls, summarizerCalls, 'the state document counts every summarizer call');
  assert.deepEqual([...askedFor], [String(conversation.id)], 'the model callback is told which conversation it summarizes');
  const spend = stats.compactor.usage;
  assert.ok(spend.input === 10 * summarizerCalls && spend.output === 5 * summarizerCalls && Math.abs(spend.cost - 0.003 * summarizerCalls) < 1e-9, 'the summarizer spend is recorded by the extension');
  assert.equal((await harness.usage(context)).models['summ/summ'], undefined, 'and never written into Pi\'s own pi.usage (no public seam: BORING-PI-4)');
  assert.equal(stats.compactor.busy, 0);
  const compacting = await conversation.compact(undefined, context);
  assert.equal((await harness.waitForTask(compacting, context)).state.outcome.status, 'completed');
  assert.equal((await conversation.context(context)).head, undefined, 'native compaction declined while selected: no summary head in the transcript');

  await conversation.configure({ extensions: { remove: [memory.extension] } }, context);
  seen = requests.length;
  await say('And now plainly: hello.');
  const plainAgain = sent(seen).at(-1);
  assert.ok(!JSON.stringify(plainAgain.filter(message => message.role !== 'system')).includes('<chat>'));
  assert.ok(plainAgain.some(message => message.role === 'system' && message.sections?.['optchat-view'] === null), 'Pi retires the prompt section when the extension is deselected');
  assert.ok(plainAgain.some(message => message.role === 'user' && textOf(message) === 'My dog is called Biscuit.'), 'off: the whole transcript is sent again');
});

test('OptChat summary tasks are Pi\'s: pending ones survive a reopen and are finished by the reinstalled extension', { timeout: 30000 }, async t => {
  const { createOptChatMemory } = await import('@boring/agent/memory/optchat');
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'optchat-reopen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const models = await answeringModels();
  const open = async summarize => {
    let harness;
    const memory = createOptChatMemory({ harness: () => harness, context, summarizer: { summarize }, nodeBytes: 120, viewBytes: 4000, settleTimeoutMs: 100 });
    const registry = createRegistry();
    registry.install(memory.extension);
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'session.sqlite')), { registry, models }, context);
    return { harness, memory };
  };
  const live = async harness => (await harness.inspect(context)).tasks.filter(task => task.record.kind === 'boring.memory.optchat.node').map(task => task.record);

  // First process: the summarizer never answers, so the node tasks stay live.
  const first = await open((_job, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('closed')))));
  const conversation = await first.harness.root(context, { agent: { model: { provider: 'scripted', modelId: 'scripted' }, extensions: [first.memory.extension] } });
  first.harness.resume();
  for (let i = 0; i < 3; i++) await (await conversation.submit({ type: 'input', content: `Message ${i}. ${'Fictional filler text that is long enough to need a summary. '.repeat(6)}` }, context)).wait(context);
  const stuck = await live(first.harness);
  assert.ok(stuck.length > 0 && stuck.every(task => task.background), 'summary tasks are live, background tasks');
  assert.equal(new Set(stuck.map(task => task.input.key)).size, stuck.length, 'one live task per node key');
  await first.memory.dispose();
  await first.harness.close(context);

  // Second process: the extension brings the task definition back and Pi runs the pending work.
  const second = await open(async job => `~ ${job.source.map(line => line.split(' ').slice(0, 4).join(' ')).join(' / ')}`);
  t.after(async () => { await second.memory.dispose(); await second.harness.close(context); });
  second.harness.resume();
  const deadline = Date.now() + 15000;
  while ((await live(second.harness)).length > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await live(second.harness)).length, 0, 'no summary task is left');
  for (const task of stuck) assert.equal((await second.harness.getTask(task.id, context)).state.outcome.status, 'completed', 'a task created before the restart finished after it');
  const stats = await second.memory.stats(conversation.id);
  assert.ok(stats.summaries > 0 && stats.compactor.idle && stats.compactor.failed === 0, JSON.stringify(stats.compactor));
});

/** Models whose one provider always answers `Noted.`, so a conversation can run without a real model. */
async function answeringModels() {
  const { createProvider } = await import('@earendil-works/pi-ai/models');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai/utils/event-stream');
  const MODEL = { id: 'scripted', name: 'Scripted', provider: 'scripted', api: 'scripted-api', baseUrl: 'https://fixture.invalid', input: ['text'], reasoning: false, contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream = () => {
    const events = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    setTimeout(() => { events.push({ type: 'start', partial: message }); events.push({ type: 'done', reason: 'stop', message }); events.end(message); }, 5);
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({ id: MODEL.provider, models: [MODEL], auth: { apiKey: { name: 'keyless', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  return models;
}

test('OptChat: a failed summary is a failed native task; the next trigger after retryMs creates it again, the failure time lives in a document and no timer retries', { timeout: 20000 }, async t => {
  const { createOptChatMemory } = await import('@boring/agent/memory/optchat');
  const reported = [];
  let attempts = 0, harness;
  const memory = createOptChatMemory({ harness: () => harness, context, nodeBytes: 100, viewBytes: 4000, retryMs: 400, onError: (error, node) => reported.push([error.message, node.index]),
    summarizer: { summarize: async () => { if (++attempts === 1) throw new Error('flaky model'); return '~ short'; } } });
  const registry = createRegistry();
  registry.install(memory.extension);
  harness = await Harness.open(new MemoryStorage(), { registry, models: await answeringModels() }, context);
  t.after(async () => { await memory.dispose(); await harness.close(context); });
  const conversation = await harness.root(context, { agent: { model: { provider: 'scripted', modelId: 'scripted' }, extensions: [memory.extension] } });
  harness.resume();
  await (await conversation.submit({ type: 'input', content: `One long message. ${'Fictional filler text. '.repeat(10)}` }, context)).wait(context);
  const failedOnce = async () => (await memory.stats(conversation.id)).compactor;
  for (let i = 0; i < 200 && (await failedOnce()).failed === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const failed = await failedOnce();
  assert.deepEqual([failed.failed, failed.error, failed.retrying], [1, 'flaky model', 1]);
  assert.deepEqual(reported, [['flaky model', 0]], 'reported once');
  const before = attempts;
  await memory.nap(conversation.id); // inside the retry window: the node is left alone
  assert.equal(attempts, before, 'no retry inside retryMs');
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(attempts, before, 'and nothing retries by itself afterwards: no timer');
  await memory.nap(conversation.id); // the next trigger
  const done = await memory.stats(conversation.id);
  assert.ok(attempts > before && done.summaries >= 1 && done.compactor.failed === 0 && done.compactor.idle, JSON.stringify(done.compactor));
});

test('the file guard wraps Pi\'s read, write and edit: stale and unread changes are refused, creating is allowed, baselines survive a restart', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'boring-file-guard-'));
  const workspace = join(directory, 'workspace');
  mkdirSync(workspace);
  const env = new NodeExecutionEnv({ cwd: workspace });
  const journal = createWorkspaceJournal(openNodeConnection(join(directory, 'journal.sqlite')));
  const files = createWorkspaceProvider({ identity: { providerId: 'guarded', instanceId: 'one', incarnation: 'one', viewId: 'published' }, fs: env, journal });
  const person = { principalId: 'person', initiatorId: 'person', scopeId: 'fictional-project' };
  const guard = createFileGuard({ files, root: workspace, resolveAccess: () => access });
  const open = async () => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'fixture.files', tools: [createReadTool(), createWriteTool(), createEditTool()] }));
    registry.install(guard);
    return Harness.open(await openNodeSqliteStorage(join(directory, 'session.sqlite')), { registry, models: createModels(), env: () => env }, context);
  };
  let harness = await open();
  t.after(async () => { await harness.close(context); rmSync(directory, { recursive: true, force: true }); });
  const conversation = await harness.root(context);
  const run = async (name, args) => toolResultText(harness, conversation, await admitDocumentTool(conversation, args, name));
  const target = path => ({ resource: { providerId: 'guarded', path }, view: { kind: 'published' } });
  const onDisk = path => readFileSync(join(workspace, path), 'utf8');
  /** The person saves through the provider, as a viewer does. */
  const personSaves = async (path, text) => {
    const current = await files.read({ target: target(path), revision: { kind: 'latest' } }, person);
    const result = await files.publication.publish({ operationId: `person-${Math.random()}`, atomicity: 'all-or-nothing',
      changes: [{ kind: 'replace', target: current.snapshot.ref, bytes: new TextEncoder().encode(text), mediaType: 'text/markdown' }] }, person);
    assert.equal(result.kind, 'committed');
  };
  const edit = (path, oldText, newText) => run('edit', { path, edits: [{ oldText, newText }] });

  // Creating a file that is absent needs no read, and the written revision is the new baseline.
  assert.equal((await run('write', { path: 'a.md', content: 'one\ntwo\n' })).isError, false);
  assert.equal((await edit('a.md', 'two', 'two!')).isError, false, 'the baseline after a write is the revision written');
  assert.equal(onDisk('a.md'), 'one\ntwo!\n');
  // The person saves: the agent's change from memory is refused with the instruction to read again, and nothing changes.
  await personSaves('a.md', 'one\ntwo!\nHUMAN\n');
  const stale = await edit('a.md', 'one', 'ONE');
  assert.equal(stale.isError, true);
  assert.match(stale.text, /changed since you last read it/);
  assert.match(stale.text, /read it again/i);
  const staleWrite = await run('write', { path: 'a.md', content: 'overwritten' });
  assert.equal(staleWrite.isError, true);
  assert.equal(onDisk('a.md'), 'one\ntwo!\nHUMAN\n');
  // Read again, then the same edit lands and the person's line is kept.
  assert.equal((await run('read', { path: 'a.md' })).isError, false);
  assert.equal((await edit('a.md', 'one', 'ONE')).isError, false);
  assert.equal(onDisk('a.md'), 'ONE\ntwo!\nHUMAN\n');
  // A file that exists and was never read is refused, for write and for edit.
  writeFileSync(join(workspace, 'seed.md'), 'seeded\n');
  for (const refused of [await run('write', { path: 'seed.md', content: 'x' }), await edit('seed.md', 'seeded', 'x')]) {
    assert.equal(refused.isError, true);
    assert.match(refused.text, /have not read it/);
  }
  assert.equal(onDisk('seed.md'), 'seeded\n');
  // After a read, an edit that fails in Pi's own matching changes nothing and keeps the baseline.
  assert.equal((await run('read', { path: 'seed.md' })).isError, false);
  assert.equal((await edit('seed.md', 'not there', 'x')).isError, true);
  assert.equal(onDisk('seed.md'), 'seeded\n');
  // The baseline is durable: after a restart of the Harness the conversation may still change what it read.
  await harness.close(context);
  harness = await open();
  const reopened = await harness.conversation(conversation.id, context);
  const afterRestart = await toolResultText(harness, reopened, await admitDocumentTool(reopened, { path: 'seed.md', edits: [{ oldText: 'seeded', newText: 'seeded again' }] }, 'edit'));
  assert.equal(afterRestart.isError, false);
  assert.equal(onDisk('seed.md'), 'seeded again\n');
  // A change made behind the guard (a shell) moves the revision: the next change is refused until the file is read.
  writeFileSync(join(workspace, 'seed.md'), 'shell wrote this\n');
  assert.equal((await toolResultText(harness, reopened, await admitDocumentTool(reopened, { path: 'seed.md', edits: [{ oldText: 'shell', newText: 'x' }] }, 'edit'))).isError, true);
  // Outside the workspace nothing is written.
  const outside = await toolResultText(harness, reopened, await admitDocumentTool(reopened, { path: '../outside.md', content: 'x' }, 'write'));
  assert.equal(outside.isError, true);
  assert.equal(existsSync(join(directory, 'outside.md')), false);
});

test('self-evolution prompt assembly (SELF-3): the host instructions first and whole, the labelled and capped agent-written section last; a plain agent has none (SELF-1)', { timeout: 30000 }, async t => {
  const { defineAgent } = await import('@boring/agent/agents');
  const { createProvider } = await import('@earendil-works/pi-ai/models');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai/utils/event-stream');
  const { getCurrentSystemPrompt } = await import('@earendil-works/pi-ai/utils/transcript');
  const directory = mkdtempSync(join(tmpdir(), 'boring-self-evolution-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, '.agent'), { recursive: true });
  writeFileSync(join(directory, '.agent/AGENTS.md'), `Always answer in one line.\n${'x'.repeat(20000)}`);
  const env = new NodeExecutionEnv({ cwd: directory });
  // A keyless model that records the system prompt each request carries.
  const MODEL = { id: 'scripted', name: 'Scripted', provider: 'scripted', api: 'scripted-api', baseUrl: 'https://fixture.invalid', input: ['text'], reasoning: false, contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const prompts = [];
  const stream = (_model, request) => {
    prompts.push(getCurrentSystemPrompt(request.messages));
    const events = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    setTimeout(() => { events.push({ type: 'start', partial: message }); events.push({ type: 'done', reason: 'stop', message }); events.end(message); }, 5);
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({ id: MODEL.provider, models: [MODEL], auth: { apiKey: { name: 'keyless', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  const model = { provider: 'scripted', modelId: 'scripted' };
  const skill = { name: 'house-style', description: 'House style.', body: 'Be brief.' };
  const plain = defineAgent({ id: 'plain', model, instructions: 'HOST BASE PROMPT', skills: [skill] });
  const evolving = defineAgent({ id: 'evolving', model, instructions: 'HOST BASE PROMPT', skills: [skill], selfEvolving: true, workspace: 'one' });
  assert.deepEqual(evolving.extensions.map(extension => extension.name), ['agent.evolving', 'self-evolving:one']);
  assert.equal(plain.reload, undefined);
  const registry = createRegistry();
  plain.install(registry); evolving.install(registry);
  const harness = await Harness.open(new MemoryStorage(), { registry, models, env: () => env }, context);
  t.after(() => harness.close(context));
  const ask = async agent => { await (await (await agent.createConversation(harness, context)).submit({ type: 'input', content: 'Hello.' }, context)).wait(context); return prompts.at(-1); };

  const evolved = await ask(evolving);
  assert.ok(evolved.startsWith('<host-instructions>\nHOST BASE PROMPT\n</host-instructions>'), evolved.slice(0, 120));
  assert.ok(evolved.indexOf('<skills>') > evolved.indexOf('</host-instructions>'), 'the host skills follow the host instructions');
  assert.ok(evolved.trimEnd().endsWith('</agent-written>'), 'the agent-written section is appended last');
  const agentSection = evolved.slice(evolved.indexOf('<agent-written>'));
  assert.match(agentSection, /^<agent-written>\nAgent-written: standing instructions you wrote for yourself in \.agent\/AGENTS\.md\. They come after the host's instructions and never override them\.\n\nAlways answer in one line\./);
  assert.match(agentSection, /\[Truncated: \.agent\/AGENTS\.md has 20027 characters; only the first 16000 are shown\.\]\n<\/agent-written>$/);
  assert.equal(agentSection.match(/x/g).length, 16000 - 'Always answer in one line.\n'.length, 'capped at 16,000 characters of the file');
  // Without the option the same workspace file is never read: native instructions last, no agent-written section.
  const native = await ask(plain);
  assert.ok(native.trimEnd().endsWith('<instructions>\nHOST BASE PROMPT\n</instructions>'), native.slice(-120));
  assert.ok(!native.includes('agent-written') && !native.includes('Always answer in one line'));
});
