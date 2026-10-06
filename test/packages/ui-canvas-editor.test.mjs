import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { openSqliteWorkspaces } from '../../examples/shared/sqlite-workspaces.mjs';

test('CanvasEditor DOM controls with fictional fonts and assets (not browser, font or geometry qualification)', async t => {
  const window = new Window({ url: 'http://localhost/' });
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'ResizeObserver', 'MutationObserver', 'DOMParser', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    const value = name === 'window' ? window : window[name];
    install(name, ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(name) ? value.bind(window) : value);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const requests = [], fontRequests = [];
  const assetBase = 'https://assets.example.invalid/';
  // Only the font/network boundary is fictional; the native editor and document runtime are real.
  class FictionalFontFace {
    constructor(family, source, descriptors) {
      this.family = family; this.source = source; Object.assign(this, descriptors);
      this.status = 'unloaded'; this.loaded = Promise.resolve(this);
      assert.ok(source.includes(assetBase), 'fonts must use host-provided asset URLs');
      fontRequests.push(source);
    }
    load() { this.status = 'loaded'; return this.loaded; }
  }
  install('FontFace', FictionalFontFace);
  Object.defineProperty(window.document, 'fonts', { configurable: true, value: new Set() });
  const fictionalFetch = async input => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    requests.push(url);
    assert.ok(url.startsWith(assetBase), `Unexpected network request: ${url}`);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  install('fetch', fictionalFetch);
  window.fetch = fictionalFetch;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(async () => {
    await window.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { createTLStore, LANGUAGES, createShapeId } = await import('@tldraw/editor');
  const { defaultEditorAssetUrls, iconTypes, DEFAULT_EMBED_DEFINITIONS } = await import('tldraw');
  const { PageRecordType, DocumentRecordType, TLDOCUMENT_ID, TLINSTANCE_ID } = await import('@tldraw/tlschema');
  const { createCanvasController } = await import('@boring/ui/canvas');
  const { CanvasEditor } = await import('@boring/ui/canvas-editor');
  const assets = {
    fonts: Object.fromEntries(Object.keys(defaultEditorAssetUrls.fonts).map(key => [key, `${assetBase}fonts/${key}.woff2`])),
    icons: Object.fromEntries(iconTypes.map(key => [key, `${assetBase}icons.svg#${key}`])),
    translations: Object.fromEntries(LANGUAGES.map(({ locale }) => [locale, `${assetBase}translations/${locale}.json`])),
    embedIcons: Object.fromEntries(DEFAULT_EMBED_DEFINITIONS.map(({ type }) => [type, `${assetBase}embed/${type}.png`])),
  };
  const identity = { scopeId: 'fictional', principalId: 'canvas-editor', initiatorId: 'alice' };
  const pageId = PageRecordType.createId('fictional-page');
  const shapeId = createShapeId('fictional-box');
  async function waitFor(predicate, message) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, message);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
  }
  function button(container, label) {
    const result = [...container.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(result, `Missing button: ${label}`);
    return result;
  }
  async function fixture(t, { readOnly = false, hostReadOnly = false, mount = true, wrapClient = client => client, title = 'Fictional canvas' } = {}) {
    const store = createTLStore();
    store.put([DocumentRecordType.create({ id: TLDOCUMENT_ID, name: title }), PageRecordType.create({ id: pageId, name: 'Original', index: 'a1' })]);
    const provider = openSqliteWorkspaces({ filename: ':memory:', providerId: 'fictional-documents', authorize: () => true });
    const target = { resource: { providerId: 'fictional-documents', path: 'canvas.json' }, view: { kind: 'published' } };
    let writes = 0;
    const client = {
      read: request => provider.read(request, identity),
      publish: request => { writes++; return provider.publication.publish(request, identity); },
      lookup: operationId => provider.reconciliation.lookup(operationId, identity),
    };
    const seed = createCanvasController({ store, client, identity, source: { kind: 'new', target }, instanceId: 'seed', epoch: 'seed' });
    assert.equal((await seed.flush(seed.actions.selection())).kind, 'saved');
    seed.dispose(); writes = 0;
    const source = { kind: 'saved', snapshot: (await client.read({ target, revision: { kind: 'latest' } })).snapshot };
    const controller = createCanvasController({ store, client: wrapClient(client), identity, source, instanceId: title, epoch: 'one', readOnly });
    store.put([store.schema.types.instance.create({ id: TLINSTANCE_ID, currentPageId: pageId, isReadonly: hostReadOnly })]);
    const container = window.document.createElement('div');
    window.document.body.append(container);
    const root = createRoot(container);
    let editor, readonlyAtMount, unmounted = false;
    const render = async (selected = controller, mounted = native => { editor = native; readonlyAtMount = native.getIsReadonly(); }, assetUrls = assets) => {
      await act(async () => root.render(createElement(CanvasEditor, { controller: selected, assetUrls, title, onMount: mounted })));
      await waitFor(() => container.querySelector('[aria-label="Canvas tools"]'), 'Native canvas did not mount');
    };
    const unmount = async () => { await act(async () => root.unmount()); unmounted = true; };
    t.after(async () => {
      if (!unmounted) await unmount();
      controller.dispose(); store.dispose(); provider.close(); container.remove();
    });
    if (mount) {
      await render();
      assert.ok(editor, 'actual native Editor must mount');
    }
    return { controller, store, client, target, source, container, root, render, unmount, get editor() { return editor; }, get readonlyAtMount() { return readonlyAtMount; }, get writes() { return writes; } };
  }
  async function readDocument(fixture) {
    const read = await fixture.client.read({ target: fixture.target, revision: { kind: 'latest' } });
    assert.equal(read.kind, 'available');
    return JSON.parse(new TextDecoder().decode(read.snapshot.bytes));
  }
  async function click(container, label) { await act(async () => button(container, label).click()); }

  await t.test('real native tools, shape edits, exact save and host asset maps', async t => {
    const f = await fixture(t);
    assert.equal(f.editor.store, f.store);
    assert.equal(f.writes, 0);
    const nativeEditor = f.editor;
    await f.render(f.controller, undefined, { fonts: { ...assets.fonts }, icons: { ...assets.icons }, translations: { ...assets.translations }, embedIcons: { ...assets.embedIcons } });
    assert.equal(f.editor, nativeEditor, 'equal host asset maps must not remount the native editor');
    await click(f.container, 'Rectangle');
    assert.equal(f.editor.getCurrentToolId(), 'geo');
    assert.equal(button(f.container, 'Rectangle').getAttribute('aria-pressed'), 'true');
    await click(f.container, 'Draw');
    assert.equal(f.editor.getCurrentToolId(), 'draw');
    await click(f.container, 'Select');
    assert.equal(f.editor.getCurrentToolId(), 'select');
    await act(async () => {
      f.editor.markHistoryStoppingPoint('fictional-shape');
      f.editor.createShape({ id: shapeId, type: 'geo', x: 30, y: 40, props: { geo: 'rectangle', w: 80, h: 60 } });
    });
    assert.equal(f.controller.getSnapshot().dirty, true);
    assert.equal(button(f.container, 'Undo').disabled, false);
    await click(f.container, 'Undo');
    assert.equal(f.store.get(shapeId), undefined);
    assert.equal(f.controller.getSnapshot().document.store[shapeId], undefined);
    assert.equal(button(f.container, 'Redo').disabled, false);
    await click(f.container, 'Redo');
    assert.equal(f.store.get(shapeId).x, 30);
    assert.equal(f.controller.getSnapshot().document.store[shapeId].props.w, 80);
    assert.equal(f.writes, 0);
    const selection = f.controller.actions.selection();
    await click(f.container, 'Save');
    await waitFor(() => !f.controller.getSnapshot().dirty, 'Save did not acknowledge the native shape');
    const document = await readDocument(f);
    assert.equal(document.store[shapeId].x, 30);
    assert.equal(document.store[shapeId].props.w, 80);
    const settled = f.controller.getSnapshot().save;
    assert.equal(settled.kind, 'settled');
    assert.equal(settled.result.kind, 'saved');
    assert.deepEqual(settled.result.selection, selection);
    assert.deepEqual(settled.result.receipt.changes[0].after, settled.result.ref);
    assert.equal(f.writes, 1);
    assert.equal(button(f.container, 'Save').disabled, true);
    assert.ok(fontRequests.length > 0);
    assert.ok(requests.includes(assets.translations.en));
    assert.equal(f.editor.hasExternalAssetHandler('file'), false);
    assert.equal(f.editor.hasExternalAssetHandler('url'), false);
  });

  await t.test('lost save acknowledgement retains newer native edits and reconciles without resubmission', async t => {
    const f = await fixture(t, { wrapClient: client => ({ ...client, publish: async request => { await client.publish(request); throw new Error('Fictional lost acknowledgement'); } }) });
    await act(async () => f.editor.updatePage({ id: pageId, name: 'Committed page' }));
    await click(f.container, 'Save');
    await waitFor(() => f.container.textContent.includes('Save unconfirmed'), 'Unknown acknowledgement was not shown');
    await act(async () => f.editor.updatePage({ id: pageId, name: 'Newer local page' }));
    assert.equal(button(f.container, 'Save').disabled, true);
    await click(f.container, 'Check save outcome');
    await waitFor(() => !f.container.textContent.includes('Save unconfirmed'), 'Reconciliation did not settle');
    assert.equal(f.store.get(pageId).name, 'Newer local page');
    assert.equal(f.controller.getSnapshot().dirty, true);
    assert.equal((await readDocument(f)).store[pageId].name, 'Committed page');
    assert.equal(f.writes, 1);
  });

  await t.test('external conflict keeps native edits until the explicit discard control is used', async t => {
    const f = await fixture(t);
    await act(async () => f.editor.updatePage({ id: pageId, name: 'Human draft' }));
    const document = JSON.parse(new TextDecoder().decode(f.source.snapshot.bytes));
    document.store[pageId].name = 'External saved page';
    const result = await f.client.publish({ operationId: 'external-change', atomicity: 'all-or-nothing', changes: [{ kind: 'replace', target: f.source.snapshot.ref, mediaType: f.source.snapshot.mediaType, bytes: new TextEncoder().encode(JSON.stringify(document)) }] });
    assert.equal(result.kind, 'committed');
    await click(f.container, 'Save');
    await waitFor(() => f.container.textContent.includes('Changed elsewhere'), 'Revision conflict was not shown');
    assert.equal(f.store.get(pageId).name, 'Human draft');
    await click(f.container, 'Discard local changes and reload');
    await waitFor(() => f.store.get(pageId).name === 'External saved page', 'Explicit discard did not load remote document');
    assert.equal(f.controller.getSnapshot().dirty, false);
  });

  await t.test('read-only native mode is set before host onMount and editing controls are disabled', async t => {
    const f = await fixture(t, { readOnly: true });
    assert.equal(f.readonlyAtMount, true);
    assert.equal(f.editor.getIsReadonly(), true);
    assert.equal(button(f.container, 'Save').disabled, true);
    for (const label of ['Draw', 'Rectangle', 'Text', 'Arrow', 'Erase', 'Undo', 'Redo']) assert.equal(button(f.container, label).disabled, true, label);
    assert.equal(button(f.container, 'Hand').disabled, false);
    await click(f.container, 'Hand');
    assert.equal(f.editor.getCurrentToolId(), 'hand');
    assert.equal(f.writes, 0);
    await f.unmount();
    assert.equal(f.store.get(TLINSTANCE_ID).isReadonly, true);
  });

  await t.test('a host read-only assertion during the mount remains in the borrowed session after unmount', async t => {
    const f = await fixture(t, { readOnly: true });
    assert.equal(f.editor.getIsReadonly(), true);
    await act(async () => f.editor.updateInstanceState({ isReadonly: true }));
    await f.unmount();
    assert.equal(f.store.get(TLINSTANCE_ID).isReadonly, true);
    assert.equal(f.controller.getSnapshot().lifecycle, 'active');
    assert.equal(f.writes, 0);
  });

  await t.test('an existing host read-only native session survives mounting and unmounting', async t => {
    const f = await fixture(t, { hostReadOnly: true });
    assert.equal(f.readonlyAtMount, true);
    assert.equal(button(f.container, 'Draw').disabled, true);
    await f.unmount();
    assert.equal(f.store.get(TLINSTANCE_ID).isReadonly, true);
  });

  await t.test('controller replacement retains the new document when the previous save acknowledges late', async t => {
    const committed = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const old = await fixture(t, { title: 'Old canvas', wrapClient: client => ({ ...client, publish: async request => {
      const result = await client.publish(request);
      committed.resolve();
      await release.promise;
      return result;
    } }) });
    await act(async () => old.editor.updatePage({ id: pageId, name: 'Old selected page' }));
    await click(old.container, 'Save');
    await committed.promise;
    const next = await fixture(t, { title: 'Next canvas', mount: false });
    let nextEditor;
    await old.render(next.controller, editor => { nextEditor = editor; });
    await waitFor(() => nextEditor?.store === next.store, 'Replacement native editor did not mount');
    await act(async () => nextEditor.updatePage({ id: pageId, name: 'Newer document draft' }));
    await act(async () => release.resolve());
    await waitFor(() => old.controller.getSnapshot().save.kind === 'settled', 'Old save did not finish');
    assert.equal(next.controller.getSnapshot().document.store[pageId].name, 'Newer document draft');
    assert.equal(next.controller.getSnapshot().dirty, true);
    assert.equal(next.controller.getSnapshot().save.kind, 'idle');
    assert.equal(next.writes, 0);
    assert.equal(old.controller.getSnapshot().lifecycle, 'active');
    assert.equal(old.editor.isDisposed, true);
    assert.ok(old.container.textContent.includes('Unsaved changes'));
    assert.equal(old.container.textContent.includes('Saving'), false);
  });

  await t.test('unmount preserves borrowed controller, native store and publication capability', async t => {
    const f = await fixture(t);
    await f.unmount();
    assert.equal(f.editor.isDisposed, true);
    assert.equal(f.controller.getSnapshot().lifecycle, 'active');
    f.store.put([{ ...f.store.get(pageId), name: 'Edit after unmount' }]);
    const result = await f.controller.flush(f.controller.actions.selection());
    assert.equal(result.kind, 'saved');
    assert.equal((await readDocument(f)).store[pageId].name, 'Edit after unmount');
  });
});
