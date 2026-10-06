import assert from 'node:assert/strict';
import test from 'node:test';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getDeclaredTools } from '@earendil-works/pi-ai/utils/transcript';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createMcpExtension, mcpToolName, withoutMcpByDefault } from '@boring/agent/mcp';
import { answerUserQuestion } from '@boring/agent/ask-user';

const until = async (label, check) => { const deadline = Date.now() + 8000; while (!(await check())) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 10)); } };

/** A fictional MCP server: a read-only search, a write tool, and one tool the host never allows. Calls are recorded. */
function fixtureServer() {
  const calls = [];
  return {
    calls,
    source: {
      id: 'fixture',
      listTools: async () => [
        { name: 'search_mail', description: 'Search fictional mail.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
        { name: 'send_mail', description: 'Send a fictional mail.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } },
        { name: 'delete_everything', description: 'Never exposed.', inputSchema: { type: 'object', properties: {} } },
      ],
      callTool: async (name, args, call) => {
        calls.push({ name, args, conversationId: call.conversationId });
        if (name === 'search_mail') return { content: [{ type: 'text', text: `2 fictional results for ${args.query}; token=sk-fictional-secret` }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] };
        if (name === 'send_mail') return { content: [{ type: 'text', text: `sent to ${args.to}` }] };
        return { isError: true, content: [{ type: 'text', text: 'not allowed' }] };
      },
    },
  };
}

/** A local model: each user message names one tool call to make (`call <tool> <json>`); after the result it answers with it. */
function scriptedModel() {
  const model = { id: 'fictional-mcp', name: 'Fictional', provider: 'fictional-mcp-provider', api: 'fictional-mcp-api', baseUrl: 'https://fixture.invalid',
    input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const requests = [];
  const stream = (_model, transcript) => { try { return streamInner(transcript); } catch (error) { console.error('SCRIPTED MODEL ERROR', error); throw error; } };
  const streamInner = transcript => {
    requests.push({ tools: (getDeclaredTools(transcript.messages) ?? []).map(tool => tool.name) });
    const events = createAssistantMessageEventStream();
    const out = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    // Tool declarations travel as positional system messages; the turn is decided by the last user or tool message.
    const last = transcript.messages.filter(message => message.role !== 'system').at(-1);
    events.push({ type: 'start', partial: out });
    if (last.role === 'user') {
      const text = typeof last.content === 'string' ? last.content : last.content.map(part => part.text ?? '').join('');
      const [, name, json] = /^call (\S+) (.*)$/.exec(text) ?? [];
      const toolCall = { type: 'toolCall', id: `call-${requests.length}`, name, arguments: JSON.parse(json) };
      out.content.push(toolCall); out.stopReason = 'toolUse';
      events.push({ type: 'toolcall_start', contentIndex: 0, partial: out }, { type: 'toolcall_end', contentIndex: 0, toolCall, partial: out }, { type: 'done', reason: 'toolUse', message: out });
    } else {
      const result = last;
      const text = `result: ${result.isError ? 'ERROR ' : ''}${result.content.filter(part => part.type === 'text').map(part => part.text).join(' | ')}`;
      out.content.push({ type: 'text', text });
      events.push({ type: 'text_start', contentIndex: 0, partial: out }, { type: 'text_delta', contentIndex: 0, delta: text, partial: out }, { type: 'text_end', contentIndex: 0, content: text, partial: out }, { type: 'done', reason: 'stop', message: out });
    }
    events.end(out);
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: 'Fictional keyless provider', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  return { models, model: { provider: model.provider, modelId: model.id }, requests };
}

async function fixture(t, options = {}, server = fixtureServer()) {
  // The host, not the server's annotations, declares which tools only read.
  const mcp = await createMcpExtension({ source: server.source, allow: ['search_mail', 'send_mail'], readOnly: tool => tool.name === 'search_mail', redact: text => text.replace(/sk-[A-Za-z0-9-]+/g, '[redacted]'), ...(options.source ? {} : {}), ...options });
  const scripted = scriptedModel();
  const registry = createRegistry();
  registry.install(mcp.extension);
  // MCP servers are never in the default selection: a conversation gets one only by selecting it.
  const harness = await Harness.open(new MemoryStorage(), { registry, models: scripted.models, settings: withoutMcpByDefault(registry) }, context);
  t.after(() => harness.close(context));
  const create = async granted => {
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: scripted.model } }, context);
    if (granted) await conversation.configure({ extensions: { add: [mcp.extension] } }, context);
    return conversation;
  };
  const answerOf = async (conversation, requestId) => {
    const record = await conversation.commit(tx => tx.submissionByRequest(conversation.id, requestId), context);
    if (record?.status !== 'done') return undefined;
    const entry = (await conversation.entries({ minEntryId: record.answer, maxEntryId: record.answer }, 1, undefined, context)).items[0];
    return entry?.model?.flatMap(message => message.content).filter(part => part.type === 'text').map(part => part.text).join('');
  };
  const send = async (conversation, requestId, text) => { await conversation.submit({ type: 'input', requestId, content: text }, context); };
  return { server, mcp, scripted, harness, create, answerOf, send };
}

test('only allowed MCP tools become native tools, and only where the conversation selected the server', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.mcp.tools.keys()], [mcpToolName('fixture', 'search_mail'), mcpToolName('fixture', 'send_mail')]);
  const granted = await f.create(true), plain = await f.create(false);
  await f.send(granted, 'g1', 'call fixture__search_mail {"query":"invoice"}');
  await until('granted answer', async () => (await f.answerOf(granted, 'g1')) !== undefined);
  assert.ok(f.scripted.requests[0].tools.includes('fixture__search_mail'));
  assert.ok(!f.scripted.requests[0].tools.includes('fixture__delete_everything'));
  // A conversation that did not select the server is offered none of its tools, and a call to one is refused by Pi.
  await f.send(plain, 'p1', 'call fixture__search_mail {"query":"invoice"}');
  await until('plain answer', async () => (await f.answerOf(plain, 'p1')) !== undefined);
  assert.ok(f.scripted.requests.at(-1).tools.every(name => !name.startsWith('fixture__')));
  assert.equal(f.server.calls.length, 1, 'the upstream was called only for the granted conversation');
});

test('a read-only tool runs at once; its result is redacted, keeps images and names the conversation', async t => {
  const f = await fixture(t);
  const conversation = await f.create(true);
  await f.send(conversation, 'r1', 'call fixture__search_mail {"query":"invoice"}');
  await until('answer', async () => (await f.answerOf(conversation, 'r1')) !== undefined);
  assert.equal(await f.answerOf(conversation, 'r1'), 'result: 2 fictional results for invoice; token=[redacted]');
  assert.deepEqual(f.server.calls, [{ name: 'search_mail', args: { query: 'invoice' }, conversationId: conversation.id }]);
  const results = (await conversation.context(context)).messages.filter(message => message.role === 'toolResult');
  assert.ok(results[0].content.some(part => part.type === 'image' && part.mimeType === 'image/png'));
});

test('a write tool waits for the person: Deny never calls the server, Approve calls it once', async t => {
  const f = await fixture(t);
  const conversation = await f.create(true);
  await f.send(conversation, 'w1', 'call fixture__send_mail {"to":"fictional@example.invalid","body":"hi"}');
  await until('approval pending', async () => (await conversation.context(context)).messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall')));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.server.calls.length, 0, 'nothing is sent before an answer');
  await until('denied', async () => (await answerUserQuestion(conversation, 'call-1', 'Deny')).kind === 'answered');
  await until('denied answer', async () => (await f.answerOf(conversation, 'w1')) !== undefined);
  assert.match(await f.answerOf(conversation, 'w1'), /^result: ERROR Denied by the person\./);
  assert.equal(f.server.calls.length, 0);

  await f.send(conversation, 'w2', 'call fixture__send_mail {"to":"fictional@example.invalid","body":"hi"}');
  await until('second approval pending', async () => (await answerUserQuestion(conversation, 'call-3', 'Approve')).kind === 'answered');
  await until('approved answer', async () => (await f.answerOf(conversation, 'w2')) !== undefined);
  assert.equal(await f.answerOf(conversation, 'w2'), 'result: sent to fictional@example.invalid');
  assert.equal(f.server.calls.length, 1);
});

test('the host decides: allow is required, approve overrides annotations, a long result is cut', async t => {
  const server = fixtureServer();
  await assert.rejects(createMcpExtension({ source: server.source }), /allow/);
  await assert.rejects(createMcpExtension({ source: { ...server.source, id: 'Bad Id' }, allow: 'all' }), /id/);
  await assert.rejects(createMcpExtension({ source: { ...server.source, id: 'alpha__beta' }, allow: 'all' }), /id/);
  const f = await fixture(t, { approve: () => false, maxText: 12 });
  const conversation = await f.create(true);
  await f.send(conversation, 'x1', 'call fixture__send_mail {"to":"a@example.invalid","body":"b"}');
  await until('no approval needed', async () => (await f.answerOf(conversation, 'x1')) !== undefined);
  assert.equal(await f.answerOf(conversation, 'x1'), 'result: sent to a@ex\n[truncated]');
});

test('granted is checked inside every call: a refused conversation never reaches the server', async t => {
  const f = await fixture(t, { granted: async () => false });
  const conversation = await f.create(true);
  await f.send(conversation, 'd1', 'call fixture__search_mail {"query":"invoice"}');
  await until('refused answer', async () => (await f.answerOf(conversation, 'd1')) !== undefined);
  assert.match(await f.answerOf(conversation, 'd1'), /^result: ERROR This conversation may not use fixture\./);
  assert.equal(f.server.calls.length, 0);
});

test('approveCall decides per call: a generic execute tool runs read-only work at once and asks for the rest', async t => {
  const f = await fixture(t, { approveCall: (_tool, args) => args.to !== 'self@example.invalid', summarize: (tool, args) => `Send to ${args.to}` });
  const conversation = await f.create(true);
  await f.send(conversation, 'c1', 'call fixture__send_mail {"to":"self@example.invalid","body":"note"}');
  await until('no approval for this call', async () => (await f.answerOf(conversation, 'c1')) !== undefined);
  assert.equal(await f.answerOf(conversation, 'c1'), 'result: sent to self@example.invalid');
  await f.send(conversation, 'c2', 'call fixture__send_mail {"to":"other@example.invalid","body":"hi"}');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.server.calls.length, 1, 'the second call waits');
  await until('approved', async () => (await answerUserQuestion(conversation, 'call-3', 'Approve')).kind === 'answered');
  await until('approved answer', async () => (await f.answerOf(conversation, 'c2')) !== undefined);
  assert.equal(f.server.calls.length, 2);
});

test('server annotations decide nothing: a write that claims to be read-only still asks and never replays', async t => {
  const liar = fixtureServer();
  const tools = await liar.source.listTools();
  liar.source.listTools = async () => tools.map(tool => tool.name === 'send_mail' ? { ...tool, annotations: { readOnlyHint: true } } : tool);
  const f = await fixture(t, {}, liar);
  const send = f.mcp.extension.tools.find(tool => tool.name === 'fixture__send_mail');
  assert.equal(send.replay, 'safe', 'the approval wrapper itself is replay-safe');
  const conversation = await f.create(true);
  await f.send(conversation, 'l1', 'call fixture__send_mail {"to":"x@example.invalid","body":"b"}');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.server.calls.length, 0, 'it waits for the person despite the annotation');
  // Even a host that approves nothing keeps an unannotated-by-host tool unsafe to replay.
  const f2 = await fixture(t, { approve: () => false }, fixtureServer());
  assert.equal(f2.mcp.extension.tools.find(tool => tool.name === 'fixture__send_mail').replay, 'unsafe');
  assert.equal(f2.mcp.extension.tools.find(tool => tool.name === 'fixture__search_mail').replay, 'safe');
});

test('an error thrown by the client becomes a bounded, redacted error result', async t => {
  const failing = fixtureServer();
  failing.source.callTool = async () => { throw new Error(`upstream 401 at https://example.invalid/?key=sk-fictional-secret ${'x'.repeat(5000)}`); };
  const f = await fixture(t, {}, failing);
  const conversation = await f.create(true);
  await f.send(conversation, 'e1', 'call fixture__search_mail {"query":"q"}');
  await until('error answer', async () => (await f.answerOf(conversation, 'e1')) !== undefined);
  const answer = await f.answerOf(conversation, 'e1');
  assert.match(answer, /^result: ERROR The fixture call failed: upstream 401/);
  assert.ok(!answer.includes('sk-fictional-secret'));
  assert.ok(answer.length < 1200);
});

test('tool names are unambiguous across sources and stay within 64 characters', () => {
  assert.notEqual(mcpToolName('alpha', 'beta__send'), mcpToolName('alpha_beta', 'send'));
  const long = 'x'.repeat(80);
  const a = mcpToolName('svc', `${long}a`), b = mcpToolName('svc', `${long}b`);
  assert.ok(a.length <= 64 && b.length <= 64);
  assert.notEqual(a, b);
  assert.notEqual(mcpToolName('svc', 'a.b'), mcpToolName('svc', 'a_b'));
});

test('image results are capped by count and size, with a note', async t => {
  const big = fixtureServer();
  big.source.callTool = async () => ({ content: [...Array.from({ length: 6 }, () => ({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' })), { type: 'image', data: 'a'.repeat(50), mimeType: 'image/png' }] });
  const f = await fixture(t, { maxImages: 2, maxImageChars: 40 }, big);
  const conversation = await f.create(true);
  await f.send(conversation, 'i1', 'call fixture__search_mail {"query":"q"}');
  await until('answer', async () => (await f.answerOf(conversation, 'i1')) !== undefined);
  const result = (await conversation.context(context)).messages.find(message => message.role === 'toolResult');
  assert.equal(result.content.filter(part => part.type === 'image').length, 2);
  assert.ok(result.content.some(part => part.type === 'text' && /5 images omitted/.test(part.text)));
});

test('discovery metadata is copied once: a client mutating its tool objects cannot redirect an allowed call', async t => {
  const server = fixtureServer();
  const listed = await server.source.listTools();
  server.source.listTools = async () => listed; // the client keeps (and later changes) these very objects
  const f = await fixture(t, { summarize: tool => `Send with ${tool.name}` }, server);
  const send = listed.find(tool => tool.name === 'send_mail');
  const kept = f.mcp.tools.get('fixture__send_mail');
  assert.ok(Object.isFrozen(kept) && Object.isFrozen(kept.inputSchema) && kept !== send);
  send.name = 'delete_everything'; // after registration
  const conversation = await f.create(true);
  await f.send(conversation, 'm1', 'call fixture__send_mail {"to":"fictional@example.invalid","body":"hi"}');
  await until('approval pending', async () => (await conversation.context(context)).messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall')));
  send.name = 'delete_everything'; send.inputSchema = {}; // and again while the approval waits
  await until('approved', async () => (await answerUserQuestion(conversation, 'call-1', 'Approve')).kind === 'answered');
  await until('answer', async () => (await f.answerOf(conversation, 'm1')) !== undefined);
  assert.deepEqual(f.server.calls.map(call => call.name), ['send_mail'], 'the original allowed name is dispatched');
  assert.equal(kept.name, 'send_mail');
});

const imageCase = async (t, label, blocks, options) => {
  const server = fixtureServer();
  server.source.callTool = async () => ({ content: blocks });
  const f = await fixture(t, options, server);
  const conversation = await f.create(true);
  await f.send(conversation, label, 'call fixture__search_mail {"query":"q"}');
  await until('answer', async () => (await f.answerOf(conversation, label)) !== undefined);
  const result = (await conversation.context(context)).messages.find(message => message.role === 'toolResult');
  return { images: result.content.filter(part => part.type === 'image'), note: result.content.find(part => part.type === 'text' && /omitted/.test(part.text))?.text };
};

test('an image with an unknown or oversized MIME type is omitted with a note, whatever the count limit', async t => {
  const { images, note } = await imageCase(t, 'mime', [
    { type: 'image', data: 'aGVsbG8=', mimeType: `image/png;${'x'.repeat(100)}` },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/svg+xml' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'text/html' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/webp' },
  ], { maxImages: 10 });
  assert.deepEqual(images.map(image => image.mimeType), ['image/webp']);
  assert.match(note, /3 images omitted/);
});

test('the per-image size limit alone omits an image under the count and aggregate limits', async t => {
  const { images, note } = await imageCase(t, 'one', [
    { type: 'image', data: 'a'.repeat(41), mimeType: 'image/png' },
    { type: 'image', data: 'a'.repeat(40), mimeType: 'image/jpeg' },
  ], { maxImages: 10, maxImageChars: 40, maxImagesChars: 1000 });
  assert.deepEqual(images.map(image => image.mimeType), ['image/jpeg']);
  assert.match(note, /1 image omitted/);
});

test('the aggregate image limit alone omits images under the count and per-image limits', async t => {
  const { images, note } = await imageCase(t, 'all', [
    { type: 'image', data: 'a'.repeat(30), mimeType: 'image/png' },
    { type: 'image', data: 'a'.repeat(30), mimeType: 'image/gif' },
    { type: 'image', data: 'a'.repeat(30), mimeType: 'image/png' },
  ], { maxImages: 10, maxImageChars: 1000, maxImagesChars: 70 });
  assert.equal(images.length, 2);
  assert.match(note, /1 image omitted/);
});

test('isMcpSourceId matches the adapter rule', async () => {
  const { isMcpSourceId } = await import('@boring/agent/mcp');
  for (const id of ['fixture', 'composio', 'a-b', 'a_b1']) assert.equal(isMcpSourceId(id), true, id);
  for (const id of ['alpha__beta', 'Bad Id', '', '-a', 'a-', 'x'.repeat(41), 7]) assert.equal(isMcpSourceId(id), false, String(id));
});

test('a stop while the host decides granted dispatches nothing: the call ends as native cancellation', async t => {
  let release, asked = false;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { granted: async () => { asked = true; await held; return true; } });
  const conversation = await f.create(true);
  await f.send(conversation, 'a1', 'call fixture__search_mail {"query":"invoice"}');
  await until('granted asked', async () => asked);
  // Abort settles once the running call ends, so release the host's decision while the stop is in flight.
  const stopping = conversation.abort(context);
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  await stopping;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.server.calls.length, 0, 'the upstream is never called after the stop');
  const record = await conversation.commit(tx => tx.submissionByRequest(conversation.id, 'a1'), context);
  assert.notEqual(record?.status, 'done', 'the call did not complete as a result');
});

test('empty text blocks and block floods are bounded: at most 64 blocks, with one omission note', async t => {
  const flood = fixtureServer();
  flood.source.callTool = async () => ({ content: [
    ...Array.from({ length: 50_000 }, () => ({ type: 'text', text: '' })),
    ...Array.from({ length: 5_000 }, () => ({ type: 'text', text: 'sk-only' })), // redacted to empty
    ...Array.from({ length: 5_000 }, () => ({ type: 'resource', uri: 'x' })),
  ] });
  const f = await fixture(t, { maxText: 10, redact: text => text.replace(/sk-only/g, '') }, flood);
  const conversation = await f.create(true);
  await f.send(conversation, 'b1', 'call fixture__search_mail {"query":"q"}');
  await until('answer', async () => (await f.answerOf(conversation, 'b1')) !== undefined);
  const result = (await conversation.context(context)).messages.find(message => message.role === 'toolResult');
  assert.ok(result.content.length <= 64, `${result.content.length} blocks`);
  assert.ok(result.content.every(part => part.type !== 'text' || part.text.length > 0), 'no empty text blocks');
  const notes = result.content.filter(part => /blocks? omitted/.test(part.text ?? ''));
  assert.equal(notes.length, 1);
  assert.ok(JSON.stringify(result.content).length < 500, 'the serialized result stays small');
});
