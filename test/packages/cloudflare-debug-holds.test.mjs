// The restart-proof barriers of the Cloudflare recipe: inert without ENABLE_DEBUG_ROUTES=1, one-shot and matched when enabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { debugHolds } from '../../examples/cloudflare/src/debug-holds.mjs';

/** A fictional provider whose streams answer at once with `answer`. */
function fictionalProvider() {
  const calls = [];
  const stream = (_model, transcript) => {
    calls.push(transcript);
    const events = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [{ type: 'text', text: 'fictional answer' }], stopReason: 'stop', timestamp: 1 };
    events.push({ type: 'start', partial: message }); events.push({ type: 'done', reason: 'stop', message }); events.end(message);
    return events;
  };
  return { calls, provider: { id: 'fictional', name: 'Fictional', auth: {}, getModels: () => [], stream, streamSimple: stream } };
}
const transcript = text => ({ messages: [{ role: 'user', content: text, timestamp: 1 }] });
const settled = async (promise, ms = 30) => Promise.race([promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), ms))]);

test('without ENABLE_DEBUG_ROUTES=1 there are no holds to wire', () => {
  for (const env of [undefined, {}, { ENABLE_DEBUG_ROUTES: '0' }, { ENABLE_DEBUG_ROUTES: 'true' }, { ENABLE_DEBUG_ROUTES: 1 }]) assert.equal(debugHolds(env), undefined);
});

test('a generation hold delays only the matching model stream, once, until released', async () => {
  const holds = debugHolds({ ENABLE_DEBUG_ROUTES: '1' });
  const { calls, provider } = fictionalProvider();
  const wrapped = holds.provider(provider);
  assert.equal(wrapped.id, 'fictional');
  assert.equal(holds.arm({ boundary: 'generation', match: 'fictional-marker' }), true);
  assert.equal(holds.arm({ boundary: 'elsewhere', match: 'x' }), false);
  assert.equal(holds.arm({ boundary: 'delivery', match: '' }), false);
  // Another request passes straight through.
  assert.equal((await wrapped.stream({}, transcript('unrelated'))).constructor.name, 'AssistantMessageEventStream');
  assert.equal(calls.length, 1);
  const held = wrapped.streamSimple({}, transcript('please fictional-marker now'));
  assert.equal(await settled(held.result()), false);
  assert.equal(calls.length, 1, 'the provider is not called while held');
  assert.deepEqual(holds.state().armed, []);
  assert.deepEqual(holds.state().waiting.map(({ boundary, match }) => ({ boundary, match })), [{ boundary: 'generation', match: 'fictional-marker' }]);
  holds.release('fictional-marker');
  assert.equal((await held.result()).content[0].text, 'fictional answer');
  assert.equal(calls.length, 2);
  // One-shot: the same text later is not held.
  assert.equal(await settled(wrapped.stream({}, transcript('fictional-marker again')).result()), true);
});

test('a delivery hold waits only for its requestId', async () => {
  const holds = debugHolds({ ENABLE_DEBUG_ROUTES: '1' });
  holds.arm({ boundary: 'delivery', match: 'channel:whatsapp:wamid.fictional' });
  assert.equal(await settled(holds.beforeSend({ channel: 'whatsapp', address: '15550001', requestId: 'channel:whatsapp:other' })), true);
  const waiting = holds.beforeSend({ channel: 'whatsapp', address: '15550001', requestId: 'channel:whatsapp:wamid.fictional' });
  assert.equal(await settled(waiting), false);
  assert.equal(holds.state().waiting[0].boundary, 'delivery');
  holds.release();
  assert.equal(await settled(waiting), true);
  assert.deepEqual(holds.state(), { armed: [], waiting: [] });
});
