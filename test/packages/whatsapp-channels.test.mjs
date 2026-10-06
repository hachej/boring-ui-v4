import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createChannelGateway, channelRequestId, pendingQuestions, questionAnswer } from '../../examples/whatsapp/channels.ts';
import { decodeChoice, encodeChoice, createWhatsAppChannel, parseWhatsAppMessages, renderWhatsAppReply, splitWhatsAppText, verifyWhatsAppSignature, whatsAppMarkdown } from '../../examples/whatsapp/channels-whatsapp.ts';
import { createAskUserTool } from '@boring/agent/ask-user';
import { requireApproval } from '@boring/agent/approval';
import { defineDoc, defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { defineAgent } from '@boring/agent/agents';
import { createFakeChatModel } from '../fixtures/fake-chat-model.mjs';
import { createScheduleExtension, fireSchedule, nextRun } from '../../examples/cloudflare/src/schedules.mjs';
import { routeSubmissions } from '@boring/agent/chat-transport';
import { createVirtualWorkspace } from '@boring/execution/virtual';

const until = async (label, check) => { const deadline = Date.now() + 8000; while (!(await check())) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 10)); } };
const webhook = (messages) => new Request('https://fixture.invalid/channels/fake', { method: 'POST', body: JSON.stringify(messages) });
/** `receivedAt` is the provider's send time: now, unless a test says otherwise. */
const message = (messageId, text, address = 'fictional-sender', receivedAt = Date.now()) => ({ channel: 'fake', address, messageId, text, receivedAt });

/** An in-memory adapter: the request body is the verified message list; sends are recorded. */
function fakeChannel({ failures = 0, retryable = true } = {}) {
  const sent = [], received = [];
  let failing = failures;
  return {
    sent, received,
    adapter: {
      id: 'fake',
      receive: async request => request.headers.get('x-handshake') ? { kind: 'response', response: new Response('handshake') } : { kind: 'messages', messages: await request.json() },
      send: async (address, reply) => { if (failing > 0) { failing -= 1; throw Object.assign(new Error('fictional outage'), { retryable }); } sent.push({ address, reply }); },
      received: async inbound => { received.push(inbound.messageId); },
    },
  };
}

/** A model that asks `args` with `ask_user` first (or calls `tool`), then answers with the tool result. */
function askingModel(args, tool = 'ask_user') {
  const model = { id: 'fictional-asker', name: 'Fictional asker', provider: 'fictional-asker-provider', api: 'fictional-asker-api', baseUrl: 'https://fixture.invalid',
    input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let calls = 0;
  const stream = (_model, transcript) => {
    const events = createAssistantMessageEventStream();
    const out = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    // A system message (a section that changed, for example after a reload) is not a turn of its own.
    const last = transcript.messages.filter(item => item.role !== 'system').at(-1);
    events.push({ type: 'start', partial: out });
    if (last?.role !== 'toolResult') {
      calls += 1;
      const toolCall = { type: 'toolCall', id: `call-${calls}`, name: tool, arguments: args };
      out.content.push(toolCall); out.stopReason = 'toolUse';
      events.push({ type: 'toolcall_start', contentIndex: 0, partial: out }, { type: 'toolcall_end', contentIndex: 0, toolCall, partial: out }, { type: 'done', reason: 'toolUse', message: out });
    } else {
      const text = tool === 'ask_user' ? `Plan uses ${JSON.parse(last.content[0].text).answer}.` : `Result: ${last.content[0].text}`;
      out.content.push({ type: 'text', text });
      events.push({ type: 'text_start', contentIndex: 0, partial: out }, { type: 'text_delta', contentIndex: 0, delta: text, partial: out },
        { type: 'text_end', contentIndex: 0, content: text, partial: out }, { type: 'done', reason: 'stop', message: out });
    }
    events.end(out);
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: 'Fictional keyless provider', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  return { models, model: { provider: model.provider, modelId: model.id } };
}

async function plainFixture(t, channel = fakeChannel(), gatewayOptions = {}) {
  const fake = createFakeChatModel();
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: fake.models }, context);
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: fake.model } }, context);
  const events = [];
  const gateway = createChannelGateway({ harness, context, adapters: [channel.adapter], retryDelaysMs: [1, 1],
    route: async inbound => inbound.address.startsWith('fictional-') ? conversation : null, onEvent: event => events.push(event), ...gatewayOptions });
  t.after(async () => { await gateway.close(); await harness.close(context); });
  return { fake, harness, conversation, gateway, channel, events, handle: gateway.handler('fake') };
}

test('a channel message becomes native input and its answer goes back to the sender', async t => {
  const { fake, conversation, handle, channel } = await plainFixture(t);
  const response = await handle(webhook([message('m1', 'Hello from the phone')]));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { schema: 'boring.channels', version: 1, accepted: 1 });
  // Acknowledged only after admission: the native submission already exists under the provider message ID.
  const record = await conversation.commit(tx => tx.submissionByRequest(conversation.id, channelRequestId({ channel: 'fake', messageId: 'm1' })), context);
  assert.ok(record);
  const call = await fake.nextCall();
  assert.equal(call.transcript.messages.at(-1).content, 'Hello from the phone');
  call.respond('**Hi** there');
  await until('reply sent', () => channel.sent.length === 1);
  assert.deepEqual(channel.sent[0], { address: 'fictional-sender', reply: { kind: 'answer', markdown: '**Hi** there' } });
  assert.deepEqual(channel.received, ['m1']);
  // The same conversation is what the web chat shows.
  const entries = (await conversation.context(context)).entries.flatMap(entry => entry.model ?? []);
  assert.deepEqual(entries.map(entry => entry.role), ['user', 'assistant']);
});

test('redelivery, unknown senders and handshakes never start a second run', async t => {
  const { fake, handle, channel, events } = await plainFixture(t);
  await handle(webhook([message('m1', 'Once')]));
  const again = await handle(webhook([message('m1', 'Once')]));
  assert.deepEqual(await again.json(), { schema: 'boring.channels', version: 1, accepted: 0 });
  const refused = await handle(webhook([message('m2', 'Who am I?', 'stranger')]));
  assert.equal((await refused.json()).accepted, 0);
  const handshake = await handle(new Request('https://fixture.invalid/channels/fake', { headers: { 'x-handshake': '1' } }));
  assert.equal(await handshake.text(), 'handshake');
  (await fake.nextCall()).respond('Only one answer.');
  await until('reply sent', () => channel.sent.length === 1);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fake.calls.length, 1);
  assert.equal(channel.sent.length, 1);
  assert.deepEqual(events.map(event => event.kind).filter(kind => kind !== 'delivered'), ['duplicate', 'refused']);
});

test('a message sent while the agent is busy queues natively and gets its own reply', async t => {
  const { fake, handle, channel } = await plainFixture(t);
  await handle(webhook([message('m1', 'First')]));
  const first = await fake.nextCall();
  await handle(webhook([message('m2', 'Second')]));
  first.respond('Answer one.');
  const second = await fake.nextCall();
  assert.equal(second.transcript.messages.at(-1).content, 'Second');
  second.respond('Answer two.');
  await until('both replies', () => channel.sent.length === 2);
  assert.deepEqual(channel.sent.map(sent => sent.reply.markdown), ['Answer one.', 'Answer two.']);
});

test('transient send failures are retried; a permanent failure is reported, not retried', async t => {
  const flaky = await plainFixture(t, fakeChannel({ failures: 2 }));
  await flaky.handle(webhook([message('m1', 'Retry me')]));
  (await flaky.fake.nextCall()).respond('Eventually.');
  await until('retried reply', () => flaky.channel.sent.length === 1);

  const broken = await plainFixture(t, fakeChannel({ failures: 5, retryable: false }));
  await broken.handle(webhook([message('m1', 'Lost')]));
  (await broken.fake.nextCall()).respond('Never sent.');
  await until('undeliverable event', () => broken.events.some(event => event.kind === 'undeliverable'));
  assert.equal(broken.channel.sent.length, 0);
});

test('ask_user questions go to the channel sender and a numbered reply answers them', async t => {
  const asker = askingModel({ question: 'Where do we picnic?', options: ['park', 'lake'] });
  const agent = defineAgent({ id: 'ask', model: asker.model, tools: [createAskUserTool()], instructions: 'Ask, then plan.' });
  const registry = createRegistry(); agent.install(registry);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: asker.models }, context);
  const conversation = await agent.createConversation(harness, context);
  const channel = fakeChannel();
  const gateway = createChannelGateway({ harness, context, adapters: [channel.adapter], route: async () => conversation });
  t.after(async () => { await gateway.close(); await harness.close(context); });
  const handle = gateway.handler('fake');

  await handle(webhook([message('m1', 'Plan a picnic')]));
  await until('question sent', () => channel.sent.length === 1);
  const pending = pendingQuestions((await conversation.context(context)).entries)[0];
  assert.deepEqual(channel.sent[0].reply, { kind: 'question', callId: pending.callId, prompt: 'Where do we picnic?', options: ['park', 'lake'], allowFreeText: false });

  await handle(webhook([message('m2', 'beach')]));
  await until('refusal and question again', () => channel.sent.length === 3);
  assert.equal(channel.sent[1].reply.kind, 'notice');
  assert.equal(channel.sent[2].reply.kind, 'question');

  await handle(webhook([message('m3', '2')]));
  await until('final answer', () => channel.sent.length === 4);
  assert.deepEqual(channel.sent[3].reply, { kind: 'answer', markdown: 'Plan uses lake.' });
  // A redelivered answer is not a new prompt once its question is settled.
  const redelivered = await handle(webhook([message('m3', '2')]));
  assert.equal((await redelivered.json()).accepted, 0);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(channel.sent.length, 4);
});

test('admitInput caps only new input: a typed answer to the last turn\'s open question still answers; a capped message is told once', async t => {
  const asker = askingModel({ question: 'Which fictional colour?', allowFreeText: true });
  const agent = defineAgent({ id: 'ask-capped', model: asker.model, tools: [createAskUserTool()], instructions: 'Ask, then plan.' });
  const registry = createRegistry(); agent.install(registry);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: asker.models }, context);
  const conversation = await agent.createConversation(harness, context);
  const channel = fakeChannel();
  // A cap of one input, reserved by request ID (a retry reuses its reservation).
  const reserved = new Set(), asked = [];
  const admitInput = async ({ requestId }) => { asked.push(requestId); if (reserved.has(requestId) || reserved.size < 1) { reserved.add(requestId); return true; } return 'Daily limit reached.'; };
  const gateway = createChannelGateway({ harness, context, adapters: [channel.adapter], route: async () => conversation, admitInput });
  t.after(async () => { await gateway.close(); await harness.close(context); });
  const handle = gateway.handler('fake');
  await handle(webhook([message('c1', 'Plan a fictional party')]));
  await until('question sent', () => channel.sent.length === 1);
  assert.equal(channel.sent[0].reply.kind, 'question');
  // The cap is reached, yet the typed answer to the open question is an answer, not new input: never asked to admitInput.
  await handle(webhook([message('c2', 'teal')]));
  await until('final answer', () => channel.sent.length === 2);
  assert.deepEqual(channel.sent[1].reply, { kind: 'answer', markdown: 'Plan uses teal.' });
  const capped = await handle(webhook([message('c3', 'Plan another one')]));
  assert.equal((await capped.json()).accepted, 0);
  await until('limit notice', () => channel.sent.length === 3);
  assert.deepEqual(channel.sent[2].reply, { kind: 'notice', text: 'Daily limit reached.' });
  // A redelivery of the capped message is a no-op: no second notice, no submission.
  assert.equal((await (await handle(webhook([message('c3', 'Plan another one')]))).json()).accepted, 0);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(channel.sent.length, 3);
  assert.deepEqual(asked.map(id => id.split(':').at(-1)), ['c1', 'c3'], 'the redelivery is recognised as handled before admission');
  assert.equal(await conversation.commit(tx => tx.submissionByRequest(conversation.id, channelRequestId({ channel: 'fake', messageId: 'c3' })), context), undefined);
});

test('recovering an owed input after a failed submission goes through the host admission path, never around it', async t => {
  const fake = createFakeChatModel();
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: fake.models }, context);
  const native = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: fake.model } }, context);
  // The host's admission (on Cloudflare: the turn reservation and PiHarness): the first attempt fails after the outbox write.
  const admissions = [];
  const hosted = routeSubmissions(native, async draft => { admissions.push(draft.requestId); if (admissions.length === 1) throw new Error('fictional admission failure'); await native.submit(draft, context); });
  const channel = fakeChannel();
  const gateway = createChannelGateway({ harness, context, adapters: [channel.adapter], route: async () => hosted, conversation: async id => String(id) === String(native.id) ? hosted : undefined });
  t.after(async () => { await gateway.close(); await harness.close(context); });
  const failed = await gateway.handler('fake')(webhook([message('r1', 'Hello after a failure')]));
  assert.equal(failed.status, 503);
  const requestId = channelRequestId({ channel: 'fake', messageId: 'r1' });
  assert.equal(await gateway.pending(requestId), true, 'still owed: a host keeps its reservation');
  await gateway.start();
  (await fake.nextCall()).respond('Recovered.');
  await until('recovered reply', () => channel.sent.length === 1);
  assert.deepEqual(admissions, [requestId, requestId], 'the recovery was admitted by the host, not submitted around it');
  assert.equal(await gateway.pending(requestId), false);
});

test('a call gated by requireApproval asks the channel sender; Approve runs it once, Deny never runs it', async t => {
  for (const [reply, expectRuns] of [['approve', 1], ['Deny', 0]]) {
    const runs = [];
    const write = requireApproval(defineTool({ name: 'save_fictional_note', description: 'Save a fictional note.', parameters: Type.Object({ title: Type.String() }), replay: 'unsafe',
      execute: async args => { runs.push(args.title); return { content: [{ type: 'text', text: `saved ${args.title}` }] }; } }), { summarize: args => `save "${args.title}"` });
    const caller = askingModel({ title: 'Fictional picnic' }, 'save_fictional_note');
    const agent = defineAgent({ id: 'gated', model: caller.model, tools: [write], instructions: 'Save.' });
    const registry = createRegistry(); agent.install(registry);
    const harness = await Harness.open(new MemoryStorage(), { registry, models: caller.models }, context);
    const conversation = await agent.createConversation(harness, context);
    const channel = fakeChannel();
    const gateway = createChannelGateway({ harness, context, adapters: [channel.adapter], route: async () => conversation });
    t.after(async () => { await gateway.close(); await harness.close(context); });
    const handle = gateway.handler('fake');

    await handle(webhook([message(`${reply}-1`, 'Save the picnic note')]));
    await until('approval question sent', () => channel.sent.length === 1);
    assert.deepEqual(channel.sent[0].reply.options, ['Approve', 'Deny']);
    assert.equal(channel.sent[0].reply.prompt, 'Allow save_fictional_note? save "Fictional picnic"');
    assert.equal(runs.length, 0);
    const answered = await handle(webhook([message(`${reply}-2`, reply)]));
    assert.equal((await answered.json()).accepted, 1); // an answer, not a new input: no second run starts
    await until('final answer', () => channel.sent.length === 2);
    assert.equal(channel.sent[1].reply.kind, 'answer');
    assert.match(channel.sent[1].reply.markdown, expectRuns ? /saved Fictional picnic/ : /Denied by the person/);
    assert.equal(runs.length, expectRuns);
  }
});

test('self-evolution with approval on a channel: reload asks with what changes, nothing applies before Approve, and the person\'s /reload applies at once without a model turn', async t => {
  const workspace = createVirtualWorkspace({ providerId: 'fictional-evolving', files: {
    '/work/.agent/AGENTS.md': 'Sign every answer as the fictional desk.\nKeep it short.\n',
    '/work/.agent/tools/echo-args.sh': 'cat\n',
    // An absolute path, and a helper the script runs: both are part of the approved files.
    '/work/.agent/tools/echo_args.json': JSON.stringify({ name: 'echo_args', description: 'Echo the fictional arguments.', parameters: { type: 'object', properties: {} }, run: 'sh /work/.agent/tools/echo-args.sh' }),
    // A helper under skills/ (not a skill: only .md files are) is part of the approved folder like any other file.
    '/work/.agent/skills/helper.sh': 'echo helped\n',
  } });
  const env = (await workspace.acquire({ operationId: 'fictional-evolving', input: { cwd: '/work' } }, context)).environment;
  const kept = { state: undefined, saves: 0 };
  const approval = { load: async () => kept.state, save: async state => { kept.state = state; kept.saves++; } };
  const caller = askingModel({}, 'reload');
  const agent = defineAgent({ id: 'evolving', model: caller.model, instructions: 'Reload when asked.', selfEvolving: { approval }, workspace: 'one' });
  const registry = createRegistry(); agent.install(registry);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: caller.models, env: () => env }, context);
  await agent.restore();
  const conversation = await agent.createConversation(harness, context);
  const channel = fakeChannel();
  // The host's command: `/reload` is the person's own approval, answered without a turn; anything else is new input.
  const gateway = createChannelGateway({ harness, context, adapters: [channel.adapter], route: async () => conversation,
    admitInput: async ({ text }) => text.trim() === '/reload' ? (await agent.reload(env, context)).text : true });
  t.after(async () => { await gateway.close(); await harness.close(context); workspace.dispose(); });
  const handle = gateway.handler('fake');
  const tools = async () => (await conversation.agent(context)).tools.map(tool => tool.name);

  for (const [n, reply] of [[1, 'Deny'], [2, 'Approve']]) {
    await handle(webhook([message(`evolve-${n}`, 'Apply your changes')]));
    await until('approval question sent', () => channel.sent.length === 2 * n - 1);
    const question = channel.sent.at(-1).reply;
    assert.deepEqual(question.options, ['Approve', 'Deny']);
    assert.equal(question.prompt, 'Allow reload? Instructions: 2 line(s) added, 0 removed (55 characters now). Skills: no change. Tools: added echo_args. Files changed: .agent/AGENTS.md, .agent/skills/helper.sh, .agent/tools/echo-args.sh, .agent/tools/echo_args.json.');
    assert.ok(!(await tools()).includes('echo_args'), 'nothing applies while the person decides');
    assert.equal(kept.state, undefined);
    await handle(webhook([message(`evolve-${n}-answer`, reply)]));
    await until('final answer', () => channel.sent.length === 2 * n);
  }
  assert.match(channel.sent[1].reply.markdown, /Denied by the person/);
  assert.match(channel.sent[3].reply.markdown, /Tools added: echo_args/);
  assert.ok((await tools()).includes('echo_args'));
  assert.equal(kept.state.instructions.text, 'Sign every answer as the fictional desk.\nKeep it short.');

  // Written but not approved: the approved instructions stay in effect, and a tool whose script changed refuses to run.
  assert.ok((await env.writeFile('.agent/AGENTS.md', 'Fictional new rule.\n', context)).ok);
  assert.ok((await env.writeFile('.agent/skills/helper.sh', 'echo changed\n', context)).ok);
  assert.equal(kept.state.instructions.text, 'Sign every answer as the fictional desk.\nKeep it short.');
  const echo = registry.snapshot().tools().find(item => item.tool.name === 'echo_args').tool;
  assert.match((await echo.execute({}, { env }, context)).content[0].text, /did not run: \.agent\/AGENTS\.md, \.agent\/skills\/helper\.sh changed since the approved reload/);
  // The person's /reload: the report comes back as a notice, the new state is saved, and no model turn ran.
  const saves = kept.saves;
  await handle(webhook([message('evolve-command', '/reload')]));
  await until('reload notice', () => channel.sent.length === 5);
  assert.equal(channel.sent[4].reply.kind, 'notice');
  assert.match(channel.sent[4].reply.text, /^Reloaded \.agent\/ \(self-evolving:one\)\.\nTools added: none\. Changed: none\./);
  assert.equal(kept.saves, saves + 1);
  assert.equal(kept.state.instructions.text, 'Fictional new rule.');
  assert.equal(await conversation.commit(tx => tx.submissionByRequest(conversation.id, channelRequestId({ channel: 'fake', messageId: 'evolve-command' })), context), undefined);
  // The same lines in another order are a change: the agent's reload asks again instead of applying it.
  assert.ok((await env.writeFile('.agent/AGENTS.md', 'Second fictional rule.\nFictional new rule.\n', context)).ok);
  await handle(webhook([message('evolve-3', '/reload')]));
  await until('reload notice', () => channel.sent.length === 6);
  assert.ok((await env.writeFile('.agent/AGENTS.md', 'Fictional new rule.\nSecond fictional rule.\n', context)).ok);
  await handle(webhook([message('evolve-4', 'Apply your changes')]));
  await until('approval question sent', () => channel.sent.length === 7);
  assert.match(channel.sent[6].reply.prompt, /^Allow reload\? Instructions: 0 line\(s\) added, 0 removed, reordered or edited/);
  assert.equal(kept.state.instructions.text, 'Second fictional rule.\nFictional new rule.');
});

test('a question of a browser-started run stays in the browser', async t => {
  const asker = askingModel({ question: 'Which colour?', options: ['red', 'blue'] });
  const agent = defineAgent({ id: 'ask', model: asker.model, tools: [createAskUserTool()], instructions: 'Ask.' });
  const registry = createRegistry(); agent.install(registry);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: asker.models }, context);
  const conversation = await agent.createConversation(harness, context);
  const channel = fakeChannel();
  const gateway = createChannelGateway({ harness, context, adapters: [channel.adapter], route: async () => conversation });
  t.after(async () => { await gateway.close(); await harness.close(context); });
  // Start a channel watch, then let the browser ask.
  await gateway.handler('fake')(webhook([message('m1', 'Ask me')]));
  await until('channel question', () => channel.sent.length === 1);
  await gateway.handler('fake')(webhook([message('m2', 'red')]));
  await until('channel answer', () => channel.sent.length === 2);
  await conversation.submit({ type: 'input', requestId: 'browser-1', content: 'Browser asks' }, context);
  await until('browser question pending', async () => pendingQuestions((await conversation.context(context)).entries).length === 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(channel.sent.length, 2);
});

test('a reply owed before a restart is delivered after it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'boring-channels-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'session.sqlite');
  const fake = createFakeChatModel();
  let harness = await Harness.open(await openNodeSqliteStorage(filename), { registry: createRegistry(), models: fake.models }, context);
  const created = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: fake.model } }, context);
  const id = created.id;
  const first = fakeChannel();
  let gateway = createChannelGateway({ harness, context, adapters: [first.adapter], route: async () => created });
  await gateway.handler('fake')(webhook([message('m1', 'Survive a restart')]));
  await fake.nextCall();
  // The process stops while the model is still answering.
  await gateway.close(); await harness.close(context);

  harness = await Harness.open(await openNodeSqliteStorage(filename), { registry: createRegistry(), models: fake.models }, context);
  const conversation = await harness.conversation(id, context);
  const second = fakeChannel();
  gateway = createChannelGateway({ harness, context, adapters: [second.adapter], route: async () => conversation });
  t.after(async () => { await gateway.close(); await harness.close(context); });
  harness.resume();
  await gateway.start();
  (await fake.nextCall()).respond('Recovered answer.');
  await until('recovered reply', () => second.sent.length === 1);
  assert.deepEqual(second.sent[0], { address: 'fictional-sender', reply: { kind: 'answer', markdown: 'Recovered answer.' } });
  assert.equal(first.sent.length, 0);
});

test('beforeSend holds a settled reply until it resolves; without it the reply goes at once', async t => {
  let release; const seen = [];
  const held = await plainFixture(t, fakeChannel(), { beforeSend: async (target, reply) => { seen.push({ target, reply }); await new Promise(resolve => { release = resolve; }); } });
  await held.handle(webhook([message('m1', 'Hold my reply')]));
  (await held.fake.nextCall()).respond('Held answer.');
  await until('beforeSend reached', () => seen.length === 1);
  assert.deepEqual(seen[0], { target: { channel: 'fake', address: 'fictional-sender', requestId: 'channel:fake:m1' }, reply: { kind: 'answer', markdown: 'Held answer.' } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(held.channel.sent.length, 0);
  assert.equal(await held.gateway.owed(), 1);
  release();
  await until('reply sent after release', () => held.channel.sent.length === 1);
  await until('owed reply settled', async () => await held.gateway.owed() === 0);

  const plain = await plainFixture(t);
  await plain.handle(webhook([message('m1', 'No hook')]));
  (await plain.fake.nextCall()).respond('Straight away.');
  await until('reply sent', () => plain.channel.sent.length === 1);
});

test('question answers accept the option, its number or free text', () => {
  const question = { callId: 'c', prompt: 'Pick', options: ['park', 'lake'], allowFreeText: true };
  assert.equal(questionAnswer(question, ' Lake '), 'lake');
  assert.equal(questionAnswer(question, '1'), 'park');
  assert.equal(questionAnswer(question, '7'), '7');
  assert.equal(questionAnswer(question, 'the beach'), 'the beach');
});

// WhatsApp Cloud API edge

const secrets = { accessToken: 'fictional-access', appSecret: 'fictional-app-secret', verifyToken: 'fictional-verify', phoneNumberId: '1000' };
const sign = body => `sha256=${createHmac('sha256', secrets.appSecret).update(body).digest('hex')}`;
const envelope = (messages, phoneNumberId = '1000') => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, messages } }] }] });
function graph() {
  const requests = [];
  let status = 200, error;
  return { requests, fail: (next, body) => { status = next; error = body; },
    fetch: async (url, init) => { requests.push({ url, init, body: JSON.parse(init.body) }); return status === 200 ? Response.json({ messages: [{ id: 'wamid.out' }] }) : Response.json(error ?? {}, { status }); } };
}
const whatsapp = (api, extra = {}) => createWhatsAppChannel({ withCredentials: use => Promise.resolve(use(secrets)), fetch: api.fetch, ...extra });

test('WhatsApp verifies the subscription challenge and the body signature', async () => {
  const channel = whatsapp(graph());
  const ok = await channel.receive(new Request('https://fixture.invalid/wa?hub.mode=subscribe&hub.verify_token=fictional-verify&hub.challenge=42'));
  assert.equal(ok.kind, 'response'); assert.equal(ok.response.status, 200); assert.equal(await ok.response.text(), '42');
  const wrong = await channel.receive(new Request('https://fixture.invalid/wa?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42'));
  assert.equal(wrong.response.status, 403);
  const body = envelope([{ id: 'wamid.1', from: '15550001', timestamp: '1700000000', type: 'text', text: { body: 'Hi agent' } }]);
  const unsigned = await channel.receive(new Request('https://fixture.invalid/wa', { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body + ' ') } }));
  assert.equal(unsigned.response.status, 401);
  const signed = await channel.receive(new Request('https://fixture.invalid/wa', { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } }));
  assert.deepEqual(signed, { kind: 'messages', messages: [{ channel: 'whatsapp', address: '15550001', messageId: 'wamid.1', text: 'Hi agent', receivedAt: 1_700_000_000_000 }] });
  assert.equal(await verifyWhatsAppSignature(new TextEncoder().encode(body), 'sha256=zz', secrets.appSecret), false);
});

test('WhatsApp parsing keeps text and choices, skips statuses, media and other numbers', () => {
  const messages = parseWhatsAppMessages(JSON.parse(envelope([
    { id: 'a', from: '1', type: 'text', text: { body: 'text' } },
    { id: 'b', from: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'lake', title: 'lake' } } },
    { id: 'c', from: '1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'the long option', title: 'the long option' } } },
    { id: 'd', from: '1', type: 'image', image: { id: 'media' } },
  ])), { phoneNumberId: '1000', receivedAt: 5 });
  assert.deepEqual(messages.map(item => [item.messageId, item.text]), [['a', 'text'], ['b', 'lake'], ['c', 'the long option']]);
  assert.deepEqual(parseWhatsAppMessages(JSON.parse(envelope([{ id: 'x', from: '1', type: 'text', text: { body: 'other' } }], '2000')), { phoneNumberId: '1000' }), []);
  assert.throws(() => parseWhatsAppMessages({ object: 'page' }));
});

test('WhatsApp renders answers, buttons, lists and numbered questions', () => {
  assert.equal(whatsAppMarkdown('# Title\n**bold** and *it*\n[docs](https://example.invalid/x)'), '*Title*\n*bold* and _it_\ndocs (https://example.invalid/x)');
  const buttons = renderWhatsAppReply({ kind: 'question', callId: 'c', prompt: 'Where?', options: ['park', 'lake'], allowFreeText: true });
  assert.equal(buttons[0].interactive.type, 'button');
  // Each option names its question, so a tap can never answer another one.
  assert.deepEqual(buttons[0].interactive.action.buttons.map(button => decodeChoice(button.reply.id)), [{ question: 'c', option: 'park' }, { question: 'c', option: 'lake' }]);
  assert.equal(buttons[0].interactive.footer.text, 'Or type your own answer.');
  const list = renderWhatsAppReply({ kind: 'question', callId: 'c', prompt: 'Which?', options: ['one', 'two', 'three', 'four'], allowFreeText: false });
  assert.equal(list[0].interactive.type, 'list');
  const numbered = renderWhatsAppReply({ kind: 'question', callId: 'c', prompt: 'Which?', options: ['an option far too long for a list row title', 'b'], allowFreeText: false });
  assert.equal(numbered[0].text.body, 'Which?\n\n1. an option far too long for a list row title\n2. b\n\nReply with a number.');
  const chunks = splitWhatsAppText(`${'a'.repeat(30)}\n\n\`\`\`\n${'b'.repeat(40)}\n\`\`\``, 40);
  assert.ok(chunks.every(chunk => chunk.length <= 40));
  assert.ok(chunks.every(chunk => (chunk.match(/```/g) ?? []).length % 2 === 0));
});

test('WhatsApp sends through the Graph API and classifies failures', async () => {
  const api = graph();
  const channel = whatsapp(api);
  await channel.send('15550001', { kind: 'answer', markdown: 'Hello' });
  assert.equal(api.requests[0].url, 'https://graph.facebook.com/v25.0/1000/messages');
  assert.equal(api.requests[0].init.headers.authorization, 'Bearer fictional-access');
  assert.deepEqual(api.requests[0].body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '15550001', type: 'text', text: { body: 'Hello', preview_url: false } });
  await channel.received({ channel: 'whatsapp', address: '15550001', messageId: 'wamid.1', text: 'x', receivedAt: 1 });
  assert.deepEqual(api.requests[1].body, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.1', typing_indicator: { type: 'text' } });
  api.fail(429);
  await assert.rejects(channel.send('1', { kind: 'notice', text: 'x' }), error => error.retryable === true);
  api.fail(400, { error: { code: 131047 } });
  await assert.rejects(channel.send('1', { kind: 'notice', text: 'x' }), error => error.retryable === false);
  api.fail(400, { error: { code: 131000, is_transient: true } });
  await assert.rejects(channel.send('1', { kind: 'notice', text: 'x' }), error => error.retryable === true);
  assert.equal(whatsapp(api, { typingIndicator: false }).received, undefined);
});

test('a signed WhatsApp webhook drives the gateway end to end', async t => {
  const api = graph();
  const fake = createFakeChatModel();
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: fake.models }, context);
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: fake.model } }, context);
  const gateway = createChannelGateway({ harness, context, adapters: [whatsapp(api)], route: async inbound => inbound.address === '15550001' ? conversation : null });
  t.after(async () => { await gateway.close(); await harness.close(context); });
  const body = envelope([{ id: 'wamid.9', from: '15550001', type: 'text', text: { body: 'Ping' } }]);
  const response = await gateway.handler('whatsapp')(new Request('https://fixture.invalid/wa', { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } }));
  assert.equal(response.status, 200);
  (await fake.nextCall()).respond('Pong');
  await until('reply posted', () => api.requests.some(request => request.body.type === 'text'));
  const sent = api.requests.find(request => request.body.type === 'text');
  assert.deepEqual(sent.body.text, { body: 'Pong', preview_url: false });
  assert.equal(sent.body.to, '15550001');
});

test('a restarted gateway sends the pending question already present when its native watch attaches', async t => {
  const asker = askingModel({ question: 'Where do we picnic?', options: ['park', 'lake'] });
  const agent = defineAgent({ id: 'ask', model: asker.model, tools: [createAskUserTool()], instructions: 'Ask, then plan.' });
  const registry = createRegistry(); agent.install(registry);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: asker.models }, context);
  const conversation = await agent.createConversation(harness, context);
  const firstChannel = fakeChannel();
  let failed = 0;
  const first = createChannelGateway({ harness, context, route: async () => conversation, retryDelaysMs: [], adapters: [{ ...firstChannel.adapter,
    send: async () => { failed++; throw { retryable: false }; },
  }] });
  const recovered = fakeChannel();
  const next = createChannelGateway({ harness, context, route: async () => conversation, adapters: [recovered.adapter] });
  t.after(async () => { await first.close(); await next.close(); await harness.close(context); });
  await first.handler('fake')(webhook([message('quiet-restart', 'Plan a picnic')]));
  await until('initial attempted notification', () => failed === 1);
  await first.close();
  const pending = pendingQuestions((await conversation.context(context)).entries)[0];
  assert.ok(pending);
  await next.start();
  await until('existing pending question delivered', () => recovered.sent.some(item => item.reply.kind === 'question'));
  assert.deepEqual(recovered.sent[0].reply, { kind: 'question', ...pending });
  await next.handler('fake')(webhook([message('quiet-answer', '2')]));
  await until('run resumed', () => recovered.sent.some(item => item.reply.kind === 'answer'));
  assert.equal(recovered.sent.filter(item => item.reply.kind === 'question').length, 1);
  assert.equal(recovered.sent.at(-1).reply.markdown, 'Plan uses lake.');
});

/** A model that asks two questions at once (two ask_user calls in one message), then reports both answers. */
function twoQuestionModel() {
  const model = { id: 'fictional-two', name: 'Fictional two', provider: 'fictional-two-provider', api: 'fictional-two-api', baseUrl: 'https://fixture.invalid',
    input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream = (_model, transcript) => {
    const events = createAssistantMessageEventStream();
    const out = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const visible = transcript.messages.filter(message => message.role !== 'system');
    events.push({ type: 'start', partial: out });
    if (visible.at(-1)?.role === 'user') {
      out.content.push({ type: 'toolCall', id: 'call-day', name: 'ask_user', arguments: { question: 'Which day?', options: ['monday', 'tuesday'] } },
        { type: 'toolCall', id: 'call-time', name: 'ask_user', arguments: { question: 'Which time?', options: ['morning', 'evening'] } });
      out.stopReason = 'toolUse';
      out.content.forEach((toolCall, index) => events.push({ type: 'toolcall_start', contentIndex: index, partial: out }, { type: 'toolcall_end', contentIndex: index, toolCall, partial: out }));
      events.push({ type: 'done', reason: 'toolUse', message: out });
    } else {
      const text = visible.filter(message => message.role === 'toolResult').map(message => JSON.parse(message.content[0].text).answer).join(' ');
      out.content.push({ type: 'text', text });
      events.push({ type: 'text_start', contentIndex: 0, partial: out }, { type: 'text_delta', contentIndex: 0, delta: text, partial: out }, { type: 'text_end', contentIndex: 0, content: text, partial: out }, { type: 'done', reason: 'stop', message: out });
    }
    events.end(out);
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: 'Fictional keyless provider', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  return { models, model: { provider: model.provider, modelId: model.id } };
}

test('with two questions open, a typed reply is refused and a tap answers only its own question', async t => {
  const asker = twoQuestionModel();
  const agent = defineAgent({ id: 'ask', model: asker.model, tools: [createAskUserTool()], instructions: 'Ask both.' });
  const registry = createRegistry(); agent.install(registry);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: asker.models }, context);
  const conversation = await agent.createConversation(harness, context);
  const channel = fakeChannel();
  const gateway = createChannelGateway({ harness, context, adapters: [channel.adapter], route: async () => conversation });
  t.after(async () => { await gateway.close(); await harness.close(context); });
  const handle = gateway.handler('fake');
  await handle(webhook([message('t1', 'Plan a meeting')]));
  await until('two questions open', async () => pendingQuestions((await conversation.context(context)).entries).length === 2);
  const [day, time] = pendingQuestions((await conversation.context(context)).entries);

  // A typed reply cannot say which question it answers: refused, nothing answered.
  await handle(webhook([message('t2', 'monday')]));
  await until('refusal notice', () => channel.sent.some(item => item.reply.kind === 'notice' && /2 questions are waiting/.test(item.reply.text)));
  assert.equal(pendingQuestions((await conversation.context(context)).entries).length, 2);

  // A tap on the second question's button answers that question, even though the first is older.
  await handle(webhook([{ ...message('t3', 'evening'), choice: { question: time.callId, option: 'evening' } }]));
  await until('time answered', async () => pendingQuestions((await conversation.context(context)).entries).every(question => question.callId !== time.callId));
  assert.ok(pendingQuestions((await conversation.context(context)).entries).some(question => question.callId === day.callId), 'the day question is still open');

  // A tap on a question that is no longer open answers nothing.
  await handle(webhook([{ ...message('t4', 'morning'), choice: { question: time.callId, option: 'morning' } }]));
  await until('closed notice', () => channel.sent.some(item => item.reply.kind === 'notice' && /no longer open/.test(item.reply.text)));

  // One question left: a typed reply now answers it.
  await handle(webhook([message('t5', 'tuesday')]));
  await until('final answer', () => channel.sent.some(item => item.reply.kind === 'answer'));
  assert.equal(channel.sent.find(item => item.reply.kind === 'answer').reply.markdown, 'tuesday evening');
});

test('WhatsApp option ids round-trip their question and fall back to text when too long', () => {
  assert.deepEqual(decodeChoice(encodeChoice('[12,"call-x"]', 'Approve')), { question: '[12,"call-x"]', option: 'Approve' });
  assert.equal(encodeChoice('q'.repeat(300), 'Approve'), undefined);
  const numbered = renderWhatsAppReply({ kind: 'question', callId: 'q'.repeat(300), prompt: 'Allow?', options: ['Approve', 'Deny'], allowFreeText: false });
  assert.equal(numbered[0].type, 'text');
  const parsed = parseWhatsAppMessages({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1' }, messages: [{ id: 'w1', from: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: encodeChoice('[3,"c"]', 'Deny'), title: 'Deny' } } }] } }] }] }, { phoneNumberId: '1' });
  assert.deepEqual(parsed[0].choice, { question: '[3,"c"]', option: 'Deny' });
  assert.equal(parsed[0].text, 'Deny');
});

/** A model that makes one gated call per title in a single message, then reports the results. */
function gatedFixtureModel(titles) {
  const model = { id: 'fictional-gated', name: 'Fictional gated', provider: 'fictional-gated-provider', api: 'fictional-gated-api', baseUrl: 'https://fixture.invalid',
    input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let runs = 0;
  const stream = (_model, transcript) => {
    const events = createAssistantMessageEventStream();
    const out = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const visible = transcript.messages.filter(message => message.role !== 'system');
    events.push({ type: 'start', partial: out });
    if (visible.at(-1)?.role === 'user') {
      runs += 1;
      titles.forEach((title, index) => out.content.push({ type: 'toolCall', id: `call-${runs}-${index}`, name: 'save_fictional_note', arguments: { title } }));
      out.stopReason = 'toolUse';
      out.content.forEach((toolCall, index) => events.push({ type: 'toolcall_start', contentIndex: index, partial: out }, { type: 'toolcall_end', contentIndex: index, toolCall, partial: out }));
      events.push({ type: 'done', reason: 'toolUse', message: out });
    } else {
      const text = visible.filter(message => message.role === 'toolResult').map(message => message.content[0].text).join(' / ');
      out.content.push({ type: 'text', text });
      events.push({ type: 'text_start', contentIndex: 0, partial: out }, { type: 'text_delta', contentIndex: 0, delta: text, partial: out }, { type: 'text_end', contentIndex: 0, content: text, partial: out }, { type: 'done', reason: 'stop', message: out });
    }
    events.end(out);
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: 'Fictional keyless provider', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  return { models, model: { provider: model.provider, modelId: model.id }, runs: () => runs };
}

async function gatedFixture(t, titles, gateways = 1, gatewayOptions = {}) {
  const runs = [];
  const write = requireApproval(defineTool({ name: 'save_fictional_note', description: 'Save a fictional note.', parameters: Type.Object({ title: Type.String() }), replay: 'unsafe',
    execute: async args => { runs.push(args.title); return { content: [{ type: 'text', text: `saved ${args.title}` }] }; } }), { summarize: args => `save "${args.title}"` });
  const caller = gatedFixtureModel(titles);
  const agent = defineAgent({ id: 'gated', model: caller.model, tools: [write], instructions: 'Save.' });
  const registry = createRegistry(); agent.install(registry);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: caller.models }, context);
  const conversation = await agent.createConversation(harness, context);
  const channel = fakeChannel();
  // Several gateways over one Harness stand for several isolates receiving the same webhook.
  const all = Array.from({ length: gateways }, () => createChannelGateway({ harness, context, adapters: [channel.adapter], route: async () => conversation, ...gatewayOptions }));
  t.after(async () => { for (const gateway of all) await gateway.close(); await harness.close(context); });
  const questions = () => channel.sent.filter(item => item.reply.kind === 'question').map(item => item.reply);
  const notices = () => channel.sent.filter(item => item.reply.kind === 'notice').map(item => item.reply.text);
  return { runs, caller, harness, conversation, channel, handles: all.map(gateway => gateway.handler('fake')), handle: all[0].handler('fake'), questions, notices };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 150));
const OutboxView = defineDoc({ kind: 'boring.channels.outbox', version: 1, scope: 'session', initial: () => ({ items: [], answers: [], bindings: {} }) });

test('an ambiguous reply is recorded as refused: its redelivery never answers the question left open', async t => {
  const f = await gatedFixture(t, ['first', 'second']);
  await f.handle(webhook([message('a1', 'Save both notes')]));
  await until('two approval questions sent', () => f.questions().length === 2);
  const [first, second] = f.questions();
  const refused = await f.handle(webhook([message('a2', 'Approve')]));
  assert.equal((await refused.json()).accepted, 1);
  await until('ambiguity notice', () => f.notices().some(text => /2 questions are waiting/.test(text)));
  await f.handle(webhook([{ ...message('a3', 'Deny'), choice: { question: first.callId, option: 'Deny' } }]));
  await settle();
  // One question left: the refused "Approve" redelivered now must not approve it.
  const again = await f.handle(webhook([message('a2', 'Approve')]));
  assert.equal((await again.json()).accepted, 0);
  await settle();
  assert.deepEqual(f.runs, []);
  assert.equal(f.caller.runs(), 1, 'and it is not a new input either');
  assert.equal(f.notices().filter(text => /questions are waiting/.test(text)).length, 1, 'the refusal is sent once');
  await f.handle(webhook([{ ...message('a4', 'Approve'), choice: { question: second.callId, option: 'Approve' } }]));
  await until('final answer', () => f.channel.sent.some(item => item.reply.kind === 'answer'));
  assert.deepEqual(f.runs, ['second']);
});

test('a legacy button with no question id answers nothing and says it is out of date', async t => {
  const f = await gatedFixture(t, ['only']);
  await f.handle(webhook([message('l1', 'Save the note')]));
  await until('approval question sent', () => f.questions().length === 1);
  // What the WhatsApp edge now makes of a tapped button whose id it cannot decode (an older build's plain "Approve").
  const [legacy] = parseWhatsAppMessages(JSON.parse(envelope([{ id: 'l2', from: 'fictional-sender', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'approve', title: 'Approve' } } }])), { phoneNumberId: '1000' });
  assert.deepEqual(legacy.choice, { question: '', option: 'Approve' });
  await f.handle(webhook([{ ...legacy, channel: 'fake' }]));
  await until('stale notice', () => f.notices().includes('That button is out of date; tap the one on the latest question.'));
  await settle();
  assert.deepEqual(f.runs, []);
  assert.equal(f.caller.runs(), 1);
  assert.equal(pendingQuestions((await f.conversation.context(context)).entries, (await (async () => { const watch = await f.conversation.watch(context); try { return watch.value.docs['pi.live']; } finally { await watch.stop(); } })())).length, 1, 'the approval is still open');
  // A template quick reply ("button" type) is treated the same way.
  const [template] = parseWhatsAppMessages(JSON.parse(envelope([{ id: 'l3', from: '1', type: 'button', button: { text: 'Approve', payload: 'x' } }])));
  assert.deepEqual(template.choice, { question: '', option: 'Approve' });
});

test('a binding is written once: a reply bound to one question keeps answering only that question', async t => {
  const f = await gatedFixture(t, ['first', 'second']);
  await f.handle(webhook([message('b1', 'Save both notes')]));
  await until('two approval questions sent', () => f.questions().length === 2);
  const [first, second] = f.questions();
  const requestId = channelRequestId({ channel: 'fake', messageId: 'b2' });
  // As if an earlier copy of b2 bound itself to the second question, then the process died before answering.
  await f.conversation.commit(async tx => { const outbox = await tx.doc(OutboxView); outbox.bindings ??= {}; outbox.bindings[requestId] = second.callId; }, context);
  // This copy's button names the first question; the stored binding wins and is not replaced.
  await f.handle(webhook([{ ...message('b2', 'Approve'), choice: { question: first.callId, option: 'Approve' } }]));
  await settle();
  assert.equal(await f.conversation.commit(async tx => (await tx.doc(OutboxView)).bindings[requestId], context), second.callId);
  await until('second approved', () => f.runs.length === 1);
  assert.deepEqual(f.runs, ['second']);
});

test('concurrent copies of one reply (one process and across gateways) answer once and never become input', async t => {
  const f = await gatedFixture(t, ['only'], 2);
  await f.handle(webhook([message('c1', 'Save the note')]));
  await until('approval question sent', () => f.questions().length === 1);
  const copy = () => webhook([message('c2', 'Approve')]);
  const responses = await Promise.all([f.handles[0](copy()), f.handles[1](copy()), f.handles[0](copy()), f.handles[1](copy())]);
  const accepted = (await Promise.all(responses.map(response => response.json()))).map(body => body.accepted);
  assert.equal(accepted.reduce((a, b) => a + b, 0), 1, `exactly one copy is accepted: ${accepted}`);
  await until('final answer', () => f.channel.sent.some(item => item.reply.kind === 'answer'));
  await settle();
  assert.deepEqual(f.runs, ['only']);
  assert.equal(f.caller.runs(), 1);
  assert.equal(await f.conversation.commit(tx => tx.submissionByRequest(f.conversation.id, channelRequestId({ channel: 'fake', messageId: 'c2' })), context), undefined, 'never admitted as input');
});

test('a reply sent before its question was asked answers nothing, typed or tapped', async t => {
  const before = Date.now() - 60_000;
  const f = await gatedFixture(t, ['only']);
  await f.handle(webhook([message('o1', 'Save the note')]));
  await until('approval question sent', () => f.questions().length === 1);
  const [question] = f.questions();
  await f.handle(webhook([message('o2', 'Approve', 'fictional-sender', before)]));
  await f.handle(webhook([{ ...message('o3', 'Approve', 'fictional-sender', before), choice: { question: question.callId, option: 'Approve' } }]));
  await until('two stale notices', () => f.notices().filter(text => /sent before the question/.test(text)).length === 2);
  await settle();
  assert.deepEqual(f.runs, []);
  assert.equal(f.caller.runs(), 1, 'nor is it a new input');
  await f.handle(webhook([message('o4', 'Approve')]));
  await until('approved', () => f.runs.length === 1);
});

test('a refused reply never answers a remaining question: past 500 newer refusals, a restart, and its own age', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'boring-channels-fresh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'session.sqlite');
  const runs = [];
  const write = requireApproval(defineTool({ name: 'save_fictional_note', description: 'Save a fictional note.', parameters: Type.Object({ title: Type.String() }), replay: 'unsafe',
    execute: async args => { runs.push(args.title); return { content: [{ type: 'text', text: `saved ${args.title}` }] }; } }), { summarize: args => `save "${args.title}"` });
  const caller = gatedFixtureModel(['first', 'second']);
  const agent = defineAgent({ id: 'gated', model: caller.model, tools: [write], instructions: 'Save.' });
  let offset = 0;
  const now = () => Date.now() + offset;
  const open = async () => {
    const registry = createRegistry(); agent.install(registry);
    const harness = await Harness.open(await openNodeSqliteStorage(filename), { registry, models: caller.models }, context);
    const channel = fakeChannel();
    const gateway = createChannelGateway({ harness, context, adapters: [channel.adapter], now, route: async () => harness.conversation(id, context) });
    return { harness, channel, gateway, handle: gateway.handler('fake'), notices: () => channel.sent.filter(item => item.reply.kind === 'notice').map(item => item.reply.text) };
  };
  let id;
  {
    const registry = createRegistry(); agent.install(registry);
    const harness = await Harness.open(await openNodeSqliteStorage(filename), { registry, models: caller.models }, context);
    id = (await agent.createConversation(harness, context)).id;
    await harness.close(context);
  }
  let s = await open();
  const startedAt = Date.now();
  await s.handle(webhook([message('r1', 'Save both notes')]));
  await until('two approval questions sent', () => s.channel.sent.filter(item => item.reply.kind === 'question').length === 2);
  const [first, second] = s.channel.sent.filter(item => item.reply.kind === 'question').map(item => item.reply);
  const original = message('r2', 'Approve');
  assert.equal((await (await s.handle(webhook([original]))).json()).accepted, 1);
  // More than 500 newer refusals: the first refusal is still on record (kept by time, not by count).
  const flood = await s.handle(webhook(Array.from({ length: 520 }, (_, index) => message(`flood-${index}`, 'Approve'))));
  assert.equal((await flood.json()).accepted, 520);
  await s.gateway.close(); await s.harness.close(context);

  s = await open();
  t.after(async () => { await s.gateway.close(); await s.harness.close(context); });
  s.harness.resume();
  await s.gateway.start();
  await s.handle(webhook([{ ...message('r3', 'Deny'), choice: { question: first.callId, option: 'Deny' } }]));
  await settle();
  // One question left: the refused original, redelivered after the restart, answers nothing.
  assert.equal((await (await s.handle(webhook([original]))).json()).accepted, 0);
  // A tap sent before the second question was asked answers nothing either, after a restart too.
  await s.handle(webhook([{ ...message('r4', 'Approve', 'fictional-sender', startedAt - 60_000), choice: { question: second.callId, option: 'Approve' } }]));
  await until('stale notice', () => s.notices().some(text => /sent before the question/.test(text)));
  // Nine days later every record of the original may be gone; the original is older than any redelivery and is refused.
  offset = 9 * 24 * 60 * 60 * 1000;
  await s.handle(webhook([{ ...message('r5', 'Approve', 'fictional-sender', now()), choice: { question: first.callId, option: 'Approve' } }])); // prunes
  assert.equal((await (await s.handle(webhook([original]))).json()).accepted, 0);
  await settle();
  assert.deepEqual(runs, []);
  await s.handle(webhook([{ ...message('r6', 'Approve', 'fictional-sender', now()), choice: { question: second.callId, option: 'Approve' } }]));
  await until('second approved', () => runs.length === 1);
  assert.deepEqual(runs, ['second']);
});

test('concurrent webhook copies share the first outcome: failure and backpressure are 503 for both', async t => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Routing fails: neither copy is acknowledged, so the provider retries.
  {
    const f = await plainFixture(t, fakeChannel(), { route: async () => { await delay(40); throw new Error('fictional routing outage'); } });
    const responses = await Promise.all([f.handle(webhook([message('k1', 'Hello')])), f.handle(webhook([message('k1', 'Hello')]))]);
    assert.deepEqual(responses.map(response => response.status), [503, 503]);
  }
  // The outbox is full: both copies report backpressure.
  {
    let target;
    const f = await plainFixture(t, fakeChannel(), { route: async () => { await delay(40); return target; } });
    target = f.conversation;
    await f.harness.commit(async tx => { const outbox = await tx.doc(OutboxView); for (let index = 0; index < 1000; index += 1) outbox.items.push({ requestId: `filler-${index}`, conversationId: f.conversation.id, channel: 'fake', address: 'fictional-sender', text: 'x', asked: [] }); }, context);
    const responses = await Promise.all([f.handle(webhook([message('k2', 'Hello')])), f.handle(webhook([message('k2', 'Hello')]))]);
    assert.deepEqual(responses.map(response => response.status), [503, 503]);
    assert.equal(await f.conversation.commit(tx => tx.submissionByRequest(f.conversation.id, channelRequestId({ channel: 'fake', messageId: 'k2' })), context), undefined);
  }
  // Success: one copy is accepted, the other is a duplicate, both acknowledged.
  {
    let target;
    const f = await plainFixture(t, fakeChannel(), { route: async () => { await delay(40); return target; } });
    target = f.conversation;
    const responses = await Promise.all([f.handle(webhook([message('k3', 'Hello')])), f.handle(webhook([message('k3', 'Hello')]))]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.deepEqual((await Promise.all(responses.map(response => response.json()))).map(body => body.accepted).sort(), [0, 1]);
    assert.equal(f.events.filter(event => event.kind === 'duplicate').length, 1);
  }
});

test('a scheduled task: approved on the channel, fired twice yet submitted once, answered; outside the reply window held until the person writes', async t => {
  // A scripted model: "Schedule ..." calls schedule_task, a tool result is reported, a scheduled run is answered, anything else is "ok".
  const model = { id: 'fictional-scheduler', name: 'Fictional scheduler', provider: 'fictional-scheduler-provider', api: 'fictional-scheduler-api', baseUrl: 'https://fixture.invalid',
    input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let scheduledRuns = 0;
  const stream = (_model, transcript) => {
    const events = createAssistantMessageEventStream();
    const out = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const last = transcript.messages.filter(item => item.role !== 'system').at(-1);
    const said = typeof last?.content === 'string' ? last.content : last?.content?.map(part => part.text ?? '').join('') ?? '';
    events.push({ type: 'start', partial: out });
    if (last?.role === 'user' && said.startsWith('Schedule')) {
      const toolCall = { type: 'toolCall', id: 'call-schedule', name: 'schedule_task', arguments: { name: 'Mail summary', instruction: 'Summarise my unread mail', when: '0 8 * * 1-5' } };
      out.content.push(toolCall); out.stopReason = 'toolUse';
      events.push({ type: 'toolcall_start', contentIndex: 0, partial: out }, { type: 'toolcall_end', contentIndex: 0, toolCall, partial: out }, { type: 'done', reason: 'toolUse', message: out });
    } else {
      if (said.startsWith('[Scheduled task')) scheduledRuns += 1;
      const text = last?.role === 'toolResult' ? `Done: ${said}` : said.startsWith('[Scheduled task "Mail summary"') ? `Summary ${scheduledRuns}: 3 fictional unread mails.` : 'ok';
      out.content.push({ type: 'text', text });
      events.push({ type: 'text_start', contentIndex: 0, partial: out }, { type: 'text_delta', contentIndex: 0, delta: text, partial: out },
        { type: 'text_end', contentIndex: 0, content: text, partial: out }, { type: 'done', reason: 'stop', message: out });
    }
    events.end(out);
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: 'Fictional keyless provider', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  // The host backend, in memory (on Cloudflare: agents' Scheduler), idempotent on the call key.
  const records = new Map();
  const backend = {
    set: async (record, { key }) => { const found = [...records.values()].find(value => value.key === key); if (found) return found; const saved = { id: `sched-${records.size + 1}`, ...record, key }; records.set(saved.id, saved); return saved; },
    list: async () => [...records.values()], cancel: async id => records.delete(id),
  };
  const agent = defineAgent({ id: 'scheduler', model: { provider: model.provider, modelId: model.id }, instructions: 'Schedule.', extensions: [createScheduleExtension({ backend })] });
  const registry = createRegistry(); agent.install(registry);
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
  const conversation = await agent.createConversation(harness, context);
  const channel = fakeChannel(), invites = [], events = [];
  let clock = Date.now();
  // A 24-hour reply window, as WhatsApp has, with an invite (a WhatsApp template).
  const adapter = { ...channel.adapter, replyWindowMs: 24 * 60 * 60 * 1000, invite: async address => { invites.push(address); } };
  const gateway = createChannelGateway({ harness, context, adapters: [adapter], route: async () => conversation, now: () => clock, onEvent: event => events.push(event) });
  t.after(async () => { await gateway.close(); await harness.close(context); });
  const handle = gateway.handler('fake');

  // Created only after the person approves it on the channel.
  await handle(webhook([message('s1', 'Schedule my mail summary every weekday at 8')]));
  await until('approval asked', () => channel.sent.length === 1);
  assert.deepEqual(channel.sent[0].reply.options, ['Approve', 'Deny']);
  assert.match(channel.sent[0].reply.prompt, /^Allow schedule_task\? "Mail summary" cron "0 8 \* \* 1-5" \(Europe\/Zurich\), next \w{3} .*: Summarise my unread mail$/);
  assert.equal(records.size, 0);
  await handle(webhook([message('s2', 'Approve')]));
  await until('confirmation', () => channel.sent.length === 2);
  assert.match(channel.sent[1].reply.markdown, /^Done: Scheduled "Mail summary" \(id sched-1\)/);
  const [record] = records.values();
  assert.equal(record.timezone, 'Europe/Zurich');
  assert.equal(record.when.utc, '0 6,7 * * 1,2,3,4,5'); // the UTC superset covering both Zurich offsets

  // The backend fires the occurrence twice (a retried callback, concurrently): one submission, one answer.
  const submit = ({ requestId, text }) => gateway.dispatch({ channel: 'fake', address: 'fictional-sender', conversation, requestId, text });
  const due = nextRun(record, Date.now());
  const fired = await Promise.all([fireSchedule(record, due, submit), fireSchedule(record, due, submit)]);
  const requestId = fired[0].requestId;
  assert.match(requestId, /^schedule:sched-1:\d{4}-\d{2}-\d{2}T08:00$/);
  assert.equal(fired[1].requestId, requestId);
  await until('scheduled answer', () => channel.sent.length === 3);
  assert.deepEqual(channel.sent[2], { address: 'fictional-sender', reply: { kind: 'answer', markdown: 'Summary 1: 3 fictional unread mails.' } });
  assert.equal(await gateway.dispatch({ channel: 'fake', address: 'fictional-sender', conversation, requestId, text: 'again' }), 'duplicate');
  // A UTC firing an hour later is 09:00 in Zurich, not an occurrence: it submits nothing.
  assert.equal(await fireSchedule(record, due + 60 * 60 * 1000, submit), undefined);
  const scheduledInputs = (await conversation.context(context)).entries.flatMap(entry => entry.model ?? []).filter(item => item.role === 'user' && String(item.content).startsWith('[Scheduled task'));
  assert.equal(scheduledInputs.length, 1);
  assert.equal(scheduledRuns, 1);

  // 25 hours after the person's last message: the next occurrence runs, its answer is held and one invite goes out.
  clock = Date.now() + 25 * 60 * 60 * 1000;
  const later = nextRun(record, due + 60_000);
  await fireSchedule(record, later, submit);
  await until('held', () => events.some(event => event.kind === 'held'));
  const held = events.find(event => event.kind === 'held');
  assert.equal(held.reply, 'answer'); assert.equal(held.invited, true); assert.match(held.requestId, /^schedule:sched-1:/); assert.notEqual(held.requestId, requestId);
  assert.deepEqual(invites, ['fictional-sender']);
  assert.equal(channel.sent.length, 3);
  assert.equal(await gateway.owed(), 0); // a held reply keeps no wake-up armed
  // The person writes: the held answer goes out, then the answer to their message.
  await handle(webhook([message('s3', 'Morning!', 'fictional-sender', clock)]));
  await until('released and answered', () => channel.sent.length === 5);
  assert.deepEqual(channel.sent.slice(3).map(sent => sent.reply.markdown).sort(), ['Summary 2: 3 fictional unread mails.', 'ok']);
  assert.deepEqual(invites, ['fictional-sender']);
  assert.equal(scheduledRuns, 2);
  // Host policy inside the tools: another conversation (a link session's, say) neither lists nor cancels this conversation's schedule.
  const tool = name => createScheduleExtension({ backend }).tools.find(item => item.name === name);
  assert.match((await tool('list_schedules').execute({}, { conversationId: 9999 })).content[0].text, /No scheduled tasks/);
  assert.equal((await tool('cancel_schedule').execute({ id: 'sched-1' }, { conversationId: 9999 })).isError, true);
  assert.ok(records.has('sched-1'));
  assert.match((await tool('list_schedules').execute({}, { conversationId: conversation.id })).content[0].text, /sched-1/);
});
