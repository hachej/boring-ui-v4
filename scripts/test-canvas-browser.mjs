import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { launch } from '@boring/testing/browser';

const evidence = resolve(process.env.CANVAS_EVIDENCE ?? '.cache/evidence/canvas-browser');
mkdirSync(evidence, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), 'boring-canvas-browser-'));
const report = { status: 'running', steps: [] };
let server, browser;
const step = async (name, run) => {
  const item = { name, status: 'running' }; report.steps.push(item);
  try { await run(); item.status = 'passed'; }
  catch (error) { item.status = 'failed'; item.error = String(error); throw error; }
};
const ready = () => browser.until('mounted canvas commands and native viewport', `window.canvasJourney?.fixture.tools?.getTarget() && window.canvasJourney.fixture.editor?.getViewportScreenBounds().w > 100`);
const run = expression => browser.evaluate(`(async () => { const j = window.canvasJourney; ${expression} })()`);
try {
  report.head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  report.dirty = execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim();
  await step('explicit Chromium binary and browser-only bundle', async () => {
    assert.ok(process.env.CHROMIUM, 'Set CHROMIUM to a Chromium or chrome-headless-shell binary');
    const bundled = await build({ entryPoints: ['test/fixtures/canvas-mounted-browser.jsx'], outdir: directory, entryNames: 'fixture', bundle: true, format: 'esm', platform: 'browser', metafile: true, define: { 'process.env.NODE_ENV': '"production"' } });
    const forbidden = Object.keys(bundled.metafile.inputs).filter(path => /pi-kernel|packages\/(agent|execution)\/|node:fs/.test(path));
    assert.deepEqual(forbidden, [], 'canvas bundle must not load kernel, agent or execution');
    writeFileSync(join(evidence, 'bundle.json'), JSON.stringify(bundled.metafile, null, 2));
  });
  await step('serve isolated fixture on loopback and launch real Chromium', async () => {
    server = createServer((request, response) => {
      if (request.url === '/fixture.js' || request.url === '/fixture.css') {
        response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
        response.end(readFileSync(join(directory, request.url.slice(1))));
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fictional canvas commands</title><link rel="stylesheet" href="/fixture.css"><style>body{margin:0}#root{width:100vw;height:100dvh}</style><div id="root"></div><script type="module" src="/fixture.js"></script>');
      } else { response.statusCode = 404; response.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await launch(`http://127.0.0.1:${server.address().port}`, { evidence });
    await ready();
  });
  for (const device of ['desktop', 'phone']) {
    await step(`${device}: inspect, select and frame preserve saved document and publication`, async () => {
      await browser.emulate(device);
      await run('j.mount();'); await ready();
      const result = await run(`
        const before = j.state();
        const inspect = await j.command('inspect');
        const select = await j.command('select', { shapeIds: j.shapeIds });
        const selected = [...j.fixture.editor.getSelectedShapeIds()];
        const frame = await j.command('frame', { shapeIds: j.shapeIds });
        const viewport = j.fixture.editor.getViewportPageBounds();
        const bounds = j.shapeIds.map(id => j.fixture.editor.getShapePageBounds(id));
        return { before, after: j.state(), inspect, select, selected, frame, viewport, bounds };
      `);
      assert.equal(result.inspect.kind, 'applied');
      assert.equal(result.inspect.value.dirty, false);
      assert.equal(result.inspect.value.shapes.length, 2);
      assert.equal(result.select.kind, 'applied');
      assert.deepEqual(result.selected.sort(), ['shape:fictional-far', 'shape:fictional-near']);
      assert.equal(result.frame.kind, 'applied');
      for (const bounds of result.bounds) {
        assert.ok(bounds.x >= result.viewport.x - 1 && bounds.y >= result.viewport.y - 1);
        assert.ok(bounds.x + bounds.w <= result.viewport.x + result.viewport.w + 1);
        assert.ok(bounds.y + bounds.h <= result.viewport.y + result.viewport.h + 1);
      }
      assert.deepEqual(result.after, result.before);
      await browser.screenshot(`${device}-framed.png`);
    });
    await step(`${device}: dirty content, stale document and page targets, locked camera`, async () => {
      const result = await run(`
        const stale = j.fixture.tools.getTarget();
        j.fixture.editor.updateShape({ id: j.shapeIds[0], type: 'geo', x: 99 });
        const dirty = await j.command('inspect');
        const before = j.state();
        const select = await j.command('select', { shapeIds: [j.shapeIds[0]] });
        const frame = await j.command('frame', { shapeIds: [j.shapeIds[0]] });
        const after = j.state();
        const oldDocument = await j.command('select', { shapeIds: [] }, stale);
        const oldPage = j.fixture.tools.getTarget();
        j.fixture.editor.setCurrentPage(j.otherPageId);
        const wrongPage = await j.command('inspect', {}, oldPage);
        j.fixture.editor.setCurrentPage(j.pageId);
        j.fixture.editor.setCameraOptions({ isLocked: true });
        const camera = structuredClone(j.fixture.editor.getCamera());
        const locked = await j.command('frame', { shapeIds: j.shapeIds });
        return { dirty, before, after, select, frame, oldDocument, wrongPage, camera, afterCamera: j.fixture.editor.getCamera(), locked };
      `);
      assert.equal(result.dirty.kind, 'applied'); assert.equal(result.dirty.value.dirty, true);
      assert.equal(result.select.kind, 'applied'); assert.equal(result.frame.kind, 'applied');
      assert.deepEqual(result.after, result.before);
      assert.equal(result.oldDocument.kind, 'stale'); assert.equal(result.wrongPage.kind, 'stale');
      assert.notEqual(result.locked.kind, 'applied'); assert.deepEqual(result.afterCamera, result.camera);
    });
    await step(`${device}: read-only commands and old mounted handles`, async () => {
      await run('window.oldCanvas = { tools: j.fixture.tools, target: j.fixture.tools.getTarget() }; j.mount(true);'); await ready();
      const result = await run(`
        const before = j.state();
        const old = await j.command('select', { shapeIds: [] }, window.oldCanvas.target, window.oldCanvas.tools);
        const select = await j.command('select', { shapeIds: j.shapeIds });
        const frame = await j.command('frame', { shapeIds: j.shapeIds });
        return { before, after: j.state(), old, select, frame, readonly: j.fixture.editor.getInstanceState().isReadonly, selected: j.fixture.editor.getSelectedShapeIds() };
      `);
      assert.equal(result.readonly, true);
      assert.notEqual(result.old.kind, 'applied');
      assert.equal(result.select.kind, 'applied'); assert.equal(result.frame.kind, 'applied');
      assert.equal(result.selected.length, 2); assert.deepEqual(result.after, result.before);
      assert.equal(result.after.writes, 0);
    });
  }
  assert.deepEqual(browser.problems.filter(problem => problem.startsWith('exception:')), []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1;
  console.error(error);
} finally {
  if (browser) { report.browserProblems = browser.problems; await browser.close(); }
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Canvas browser journey ${report.status}: ${evidence}`);
}
