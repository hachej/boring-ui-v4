// Child process for test/contracts/mcp-replay-crash.test.mjs: a fictional MCP write is approved (or exempted), performs its
// upstream effect, then the process is SIGKILLed before Pi records the tool result. The recover phase reopens the same storage.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createMcpExtension, withoutMcpByDefault } from '@boring/agent/mcp';
import { answerUserQuestion } from '@boring/agent/ask-user';

const [directory, phase, mode] = process.argv.slice(2);
const effects = join(directory, 'effects.log');
const effectLines = () => existsSync(effects) ? readFileSync(effects, 'utf8').split('\n').filter(Boolean) : [];
let conversationId;

// A fictional server. `send_mail` changes something upstream; in `annotated` mode the server claims it only reads.
const source = {
  id: 'fixture',
  listTools: async () => [
    { name: 'send_mail', description: 'Send a fictional mail.', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
      ...(mode === 'annotated' ? { annotations: { readOnlyHint: true, idempotentHint: true } } : {}) },
    { name: 'search_mail', description: 'Search fictional mail.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  ],
  callTool: async (name, args) => {
    appendFileSync(effects, `${phase} ${name} ${JSON.stringify(args)}\n`); // the upstream effect happens
    if (phase === 'hold') {
      writeFileSync(join(directory, 'ready.json'), JSON.stringify({ conversationId }));
      await new Promise(() => {}); // ...and the process dies before Pi records the result
    }
    return { content: [{ type: 'text', text: `${name} done` }] };
  },
};
const mcp = await createMcpExtension({
  source, allow: ['send_mail', 'search_mail'],
  readOnly: tool => tool.name === 'search_mail',
  // `exempted`: the host's per-call rule skips the question for this call, but the tool is still not a host-declared read.
  ...(mode === 'exempted' ? { approveCall: () => false } : {}),
});

const model = { id: 'fictional-mcp', name: 'Fictional', provider: 'fictional-mcp-provider', api: 'fictional-mcp-api', baseUrl: 'https://fixture.invalid',
  input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const stream = (_model, transcript) => {
  const events = createAssistantMessageEventStream();
  const out = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const last = transcript.messages.filter(message => message.role !== 'system').at(-1);
  events.push({ type: 'start', partial: out });
  if (last.role === 'user') {
    const text = typeof last.content === 'string' ? last.content : last.content.map(part => part.text ?? '').join('');
    const [, name, json] = /^call (\S+) (.*)$/.exec(text);
    const toolCall = { type: 'toolCall', id: 'call-1', name, arguments: JSON.parse(json) };
    out.content.push(toolCall); out.stopReason = 'toolUse';
    events.push({ type: 'toolcall_start', contentIndex: 0, partial: out }, { type: 'toolcall_end', contentIndex: 0, toolCall, partial: out }, { type: 'done', reason: 'toolUse', message: out });
  } else {
    const text = `result: ${last.isError ? 'ERROR ' : ''}${last.content.filter(part => part.type === 'text').map(part => part.text).join(' | ')}`;
    out.content.push({ type: 'text', text });
    events.push({ type: 'text_start', contentIndex: 0, partial: out }, { type: 'text_delta', contentIndex: 0, delta: text, partial: out }, { type: 'text_end', contentIndex: 0, content: text, partial: out }, { type: 'done', reason: 'stop', message: out });
  }
  events.end(out);
  return events;
};
const models = createModels();
models.setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: 'Fictional keyless provider', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));

const registry = createRegistry();
registry.install(mcp.extension);
const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'native.sqlite')), { registry, models, settings: withoutMcpByDefault(registry) }, context);
harness.resume();
const call = mode === 'host-read' ? 'fixture__search_mail {"query":"invoice"}' : 'fixture__send_mail {"to":"fictional@example.invalid"}';

if (phase === 'hold') {
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: model.provider, modelId: model.id } } }, context);
  conversationId = conversation.id;
  await conversation.configure({ extensions: { add: [mcp.extension] } }, context);
  await conversation.submit({ type: 'input', requestId: 'r1', content: `call ${call}` }, context);
  if (mode === 'gated' || mode === 'annotated') {
    while ((await answerUserQuestion(conversation, 'call-1', 'Approve')).kind !== 'answered') await delay(10);
  }
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else {
  ({ conversationId } = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')));
  const conversation = await harness.conversation(conversationId, context);
  const deadline = Date.now() + 15000;
  let record;
  while (Date.now() < deadline) {
    record = await conversation.commit(tx => tx.submissionByRequest(conversation.id, 'r1'), context);
    if (record?.status === 'done') break;
    await delay(20);
  }
  const results = (await conversation.context(context)).messages.filter(message => message.role === 'toolResult');
  writeFileSync(join(directory, 'recovered.json'), JSON.stringify({
    status: record?.status, effects: effectLines(),
    results: results.map(result => ({ isError: result.isError, text: result.content.filter(part => part.type === 'text').map(part => part.text).join('') })),
  }));
  await harness.close(context);
}
