import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

/** A local public provider whose real stream advances only when the test responds. */
export function createFakeChatModel() {
  const model = {
    id: 'fictional-chat', name: 'Fictional local chat', provider: 'fictional-chat-provider', api: 'fictional-chat-api',
    baseUrl: 'https://fixture.invalid', input: ['text', 'image'], reasoning: false, contextWindow: 32768, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const calls = [], waiting = [], unread = [];
  const stream = (_model, transcript, options = {}) => {
    const events = createAssistantMessageEventStream();
    const message = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      timestamp: 1, stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    let ended = false, resolveAborted;
    const aborted = new Promise(resolve => { resolveAborted = resolve; });
    const abort = () => {
      if (ended) return;
      ended = true;
      message.stopReason = 'aborted'; message.errorMessage = 'Fictional provider cancelled';
      events.push({ type: 'error', reason: 'aborted', error: message });
      events.end(message);
      resolveAborted();
    };
    events.push({ type: 'start', partial: message });
    const append = text => {
      if (ended) throw new Error('Fictional stream already ended');
      if (!message.content.length) {
        message.content.push({ type: 'text', text: '' });
        events.push({ type: 'text_start', contentIndex: 0, partial: message });
      }
      message.content[0].text += text;
      events.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
    };
    const call = {
      transcript: structuredClone(transcript), signal: options.signal, aborted, append,
      respond: text => {
        append(text);
        events.push({ type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message });
        events.push({ type: 'done', reason: 'stop', message });
        events.end(message); ended = true;
        options.signal?.removeEventListener('abort', abort);
      },
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    calls.push(call);
    const next = waiting.shift();
    if (next) next(call); else unread.push(call);
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: model.provider, models: [model],
    auth: { apiKey: { name: 'Fictional keyless provider', resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream },
  }));
  return {
    models, model: { provider: model.provider, modelId: model.id }, calls,
    nextCall: () => unread.length ? Promise.resolve(unread.shift()) : new Promise(resolve => waiting.push(resolve)),
  };
}
