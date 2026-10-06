// Keyless scripted model and isolated demo agent shared by the browser correctness gate (which uses the model with the standard agent) and the native smoke test.
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { defineAgent } from '@boring/agent/agents';
import { createAskUserTool, answerUserQuestion } from '@boring/agent/ask-user';
import assert from 'node:assert/strict';

/** A fictional keyless provider around one stream function: the single fake-model mechanism of the studio gates (the correctness fixture and the scripted layer). */
export function createFixtureModels(models, stream, id = models[0].provider) {
  const registry = createModels();
  registry.setProvider(createProvider({ id, models, auth: { apiKey: { name: 'Fictional keyless provider', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  return registry;
}
export const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** An assistant message for a fixture model. */
export const assistantMessage = (model, content, stopReason) => ({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason, usage: structuredClone(ZERO_USAGE) });

export function createCorrectnessFixture() {
  const encode = text => new TextEncoder().encode(text);
  let target;
  const model = { id: 'fictional-correctness', name: 'Fictional correctness', provider: 'fictional-correctness', api: 'fictional-correctness',
    baseUrl: 'https://fictional.invalid', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const transcripts = [];
  const stream = (_model, transcript) => {
    transcripts.push(structuredClone(transcript));
    const questions = [{ question: 'Where do we picnic?', options: ['park', 'lake'] }, { question: 'Which color?', options: ['red', 'blue'] }];
    const question = questions[transcripts.length - 1];
    const part = question ? { type: 'toolCall', id: 'reused-fictional-call', name: 'ask_user', arguments: question } : { type: 'text', text: 'Fictional plan complete.' };
    const message = assistantMessage(model, [part], question ? 'toolUse' : 'stop');
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => { events.push({ type: 'start', partial: message }); events.push({ type: 'done', reason: message.stopReason, message }); events.end(message); });
    return events;
  };
  const models = createFixtureModels([model], stream);
  const demo = async host => {
    target = host.target('correctness.md');
    const seeded = await host.resources.publication.publish({ operationId: 'fictional-seed', atomicity: 'all-or-nothing', changes: [
      { kind: 'create', target, expected: { kind: 'absent' }, bytes: encode('# Fictional notes\n'), mediaType: 'text/markdown' },
    ] }, host.agentAccess);
    assert.equal(seeded.kind, 'committed');
    return { group: 'Qualification', title: 'Correctness journey', description: 'Fictional questions and document edits.',
      panel: { kind: 'markdown', target, title: 'Fictional notes' },
      artifact: { type: 'markdown', mediaType: 'text/markdown', tools: [] },
      agent: defineAgent({ id: 'correctness', model: { provider: model.provider, modelId: model.id }, tools: [createAskUserTool()] }),
      answer: (conversation, id, answer) => answerUserQuestion(conversation, id, answer, host.context),
      chat: { slash: false, mentions: false, attachments: false, models: [], efforts: [] } };
  };
  return { models, model, transcripts, demo, get target() { return target; } };
}
