import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createMarkdownController } from '@boring/ui/markdown';
import { useSaved } from '../../registry/pi-app/use-saved.ts';
import { useRemoteChat } from '../../registry/pi-app/use-remote-chat.ts';

const identity = owner => ({ runtimeId: owner, scopeId: owner, principalId: owner });
const target = (providerId, view = { kind: 'published' }) => ({ resource: { providerId, path: 'notes.md' }, view });
const snapshot = (locator, text) => ({ ref: { ...locator, revision: 'shared-revision' }, bytes: new TextEncoder().encode(text), mediaType: 'text/markdown' });

test('app hooks isolate mounted state by owner and resource (DOM, not browser qualification)', async t => {
  const window = new Window({ url: 'https://fictional.invalid/' });
  const globals = new Map();
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  t.after(async () => {
    await window.happyDOM.close();
    for (const [name, value] of globals) { if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; }
  });
  async function mount(hook) {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container), renders = [];
    let state;
    function Probe(props) { state = hook(props); renders.push(state); return null; }
    return { get state() { return state; }, renders,
      render: props => act(async () => root.render(createElement(Probe, props))),
      close: async () => { await act(async () => root.unmount()); container.remove(); } };
  }
  await t.test('remote chat changes owner and endpoint, withholds old state, and clears on logout', async () => {
    const opened = [], requests = [], streams = new Set();
    const fetch = async request => {
      requests.push(request.url);
      if (new URL(request.url).searchParams.get('op') !== 'watch') return Response.json({ kind: 'configured' });
      opened.push(request.url);
      let stream;
      const body = new ReadableStream({ start(controller) {
        stream = controller; streams.add(controller);
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ kind: 'view', view: { conversation: { id: 1 }, entries: [], docs: {} } }) + '\n'));
        request.signal.addEventListener('abort', () => { if (streams.delete(controller)) controller.close(); }, { once: true });
      }, cancel() { streams.delete(stream); } });
      return new Response(body);
    };
    const probe = await mount(useRemoteChat);
    const props = owner => ({ conversationId: '1', identity: identity(owner), endpoint: () => `https://fictional.invalid/${owner}`, fetch: request => fetch(request) });
    try {
      await probe.render(props('A'));
      assert.equal(probe.state.status, 'ready');
      const first = probe.state.controller;
      await probe.render(props('A'));
      assert.equal(probe.state.controller, first, 'inline callback replacement must not reconnect');
      const start = probe.renders.length;
      await probe.render(props('B'));
      assert.equal(probe.renders[start].status, 'connecting', 'old owner is withheld during the first render');
      assert.equal(probe.state.controller.getSnapshot().identity.principalId, 'B');
      assert.equal(first.getSnapshot().disposed, true);
      assert.equal(opened.length, 2);
      const second = probe.state.controller;
      await probe.render({ ...props('B'), endpoint: () => 'https://fictional.invalid/B-new' });
      assert.notEqual(probe.state.controller, second);
      assert.equal(opened.length, 3);
      const latest = probe.state.controller;
      await probe.render({ ...props('B'), identity: undefined });
      assert.equal(probe.state.status, 'connecting');
      assert.equal(latest.getSnapshot().disposed, true);
    } finally { await probe.close(); for (const stream of streams) stream.close(); }
  });
  for (const dirty of [false, true]) for (const change of ['provider', 'view', 'client']) await t.test(`saved viewer changes ${change} with dirty=${dirty}`, async () => {
    const reads = [];
    const client = { read: async ({ target: locator }) => { reads.push(locator); return { kind: 'available', snapshot: snapshot(locator, locator.resource.providerId + ':' + locator.view.kind) }; } };
    const create = initial => createMarkdownController({ identity: { scopeId: 'fictional', principalId: 'person', initiatorId: 'person' }, client, source: { kind: 'saved', snapshot: initial }, instanceId: 'editor', epoch: 'page' });
    const probe = await mount(useSaved);
    try {
      await probe.render({ client, target: target('A'), create });
      const first = probe.state.controller;
      if (dirty) first.actions.edit('private draft');
      const nextTarget = change === 'provider' ? target('B') : change === 'view' ? target('A', { kind: 'working', viewId: 'private' }) : target('A');
      const nextClient = change === 'client' ? { ...client } : client;
      const start = probe.renders.length;
      await probe.render({ client: nextClient, target: nextTarget, create });
      assert.equal(probe.renders[start].kind, 'loading', 'old target is withheld during the first render');
      assert.notEqual(probe.state.controller, first);
      assert.equal(first.getSnapshot().lifecycle, 'disposed');
      assert.equal(probe.state.controller.getSnapshot().lifecycle, 'active');
      assert.equal(probe.state.controller.getSnapshot().dirty, false);
      assert.equal(reads.length, 2);
      const current = probe.state.controller;
      await probe.render({ client: nextClient, target: structuredClone(nextTarget), create: initial => create(initial) });
      assert.equal(probe.state.controller, current, 'equivalent locator and callback churn preserve the controller');
    } finally { await probe.close(); }
  });
  await t.test('a late previous-owner read cannot replace the new resource', async () => {
    const delayed = Promise.withResolvers();
    const client = { read: ({ target: locator }) => locator.resource.providerId === 'A' ? delayed.promise : Promise.resolve({ kind: 'available', snapshot: snapshot(locator, 'B') }) };
    const probe = await mount(useSaved);
    try {
      await probe.render({ client, target: target('A') });
      await probe.render({ client, target: target('B') });
      assert.equal(probe.state.text, 'B');
      await act(async () => delayed.resolve({ kind: 'available', snapshot: snapshot(target('A'), 'private A') }));
      assert.equal(probe.state.text, 'B');
    } finally { await probe.close(); }
  });
});
