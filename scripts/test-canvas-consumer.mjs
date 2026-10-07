import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCaptured } from './run-captured.mjs';
import { prepareConsumerIsolation, assertConsumerTypeFiles, npmInstallFlags } from './consumer-isolation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const editor = process.argv.includes('--editor');
assert.ok(process.argv.slice(2).every(value => value === '--editor'), 'Only --editor is supported');
const directory = mkdtempSync(join(tmpdir(), editor ? 'boring-canvas-editor-consumer-' : 'boring-canvas-consumer-'));
const cache = process.env.npm_config_cache;
assert.ok(cache, 'Set npm_config_cache to a writable npm cache (npm run sets it)');
function run(command, args, env) {
  const result = runCaptured(command, args, { cwd: directory, timeout: 120000, ...(env ? { env } : {}) });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `${command} failed: ${result.error?.message ?? result.signal ?? result.status}`);
  return result.stdout;
}
try {
  const isolated = prepareConsumerIsolation(directory);
  mkdirSync(join(directory, 'packs'));
  const archives = [];
  for (const name of ['files', 'ui']) {
    const packed = JSON.parse(run('npm', ['pack', join(root, 'packages', name), '--json', '--ignore-scripts', '--pack-destination', join(directory, 'packs')]))[0];
    archives.push(join(directory, 'packs', packed.filename));
  }
  const ui = JSON.parse(readFileSync(join(root, 'packages/ui/package.json'), 'utf8'));
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const sourceLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const dependencies = Object.fromEntries(['@tldraw/editor', '@tldraw/store', 'react', 'react-dom'].map(name => [name, ui.peerDependencies[name]]));
  if (editor) dependencies.tldraw = ui.peerDependencies.tldraw;
  dependencies['@tldraw/tlschema'] = sourceLock.packages['node_modules/@tldraw/tlschema'].version;
  for (const name of ['typescript', '@types/react', '@types/react-dom', '@types/node', 'happy-dom', 'esbuild']) dependencies[name] = rootManifest.devDependencies[name];
  for (const [name, version] of Object.entries(dependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `Expected an exact dependency pin: ${name}`);
  const manifest = { name: 'isolated-canvas-consumer', version: '1.0.0', private: true, type: 'module', dependencies };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  const packages = {};
  const include = (name, parent = '') => {
    let path = `${parent}/node_modules/${name}`.replace(/^\//, '');
    while (!sourceLock.packages[path] && parent) {
      const ancestor = parent.lastIndexOf('/node_modules/');
      parent = ancestor === -1 ? '' : parent.slice(0, ancestor);
      path = `${parent}/node_modules/${name}`.replace(/^\//, '');
    }
    if (packages[path]) return;
    const entry = sourceLock.packages[path];
    assert.ok(entry && !entry.link, `Missing registry lock entry: ${name}`);
    packages[path] = entry;
    for (const dependency of Object.keys(entry.dependencies ?? {})) include(dependency, path);
    for (const dependency of Object.keys(entry.optionalDependencies ?? {})) {
      if (sourceLock.packages[`node_modules/${dependency}`]) include(dependency, path);
    }
    for (const dependency of Object.keys(entry.peerDependencies ?? {})) if (!entry.peerDependenciesMeta?.[dependency]?.optional) include(dependency, path);
  };
  for (const name of Object.keys(dependencies)) include(name);
  packages[''] = { name: manifest.name, version: manifest.version, dependencies };
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }));
  run('npm', ['install', '--package-lock-only', ...npmInstallFlags(cache), ...archives]);
  run('npm', ['ci', ...npmInstallFlags(cache)]);
  for (const name of ['@earendil-works/pi-durable', '@earendil-works/chord', '@earendil-works/pi-ai', '@boring/agent', '@boring/execution', 'marked', ...(editor ? [] : ['tldraw'])]) assert.equal(existsSync(join(directory, 'node_modules', name)), false, name);
  writeFileSync(join(directory, 'consumer.ts'), `import { createCanvasController, type CanvasController, type CanvasOptions } from '@boring/ui/canvas';
import type { TLStore, TLStoreSnapshot } from '@tldraw/editor';
declare const options: CanvasOptions;
const controller: CanvasController = createCanvasController(options);
const nativeStore: TLStore = controller.store;
const document: TLStoreSnapshot = controller.getSnapshot().document;
nativeStore.loadStoreSnapshot(document);
controller.flush(controller.actions.selection());
controller.actions.reconcile();
controller.actions.refresh();
controller.actions.discardToRemote();
const problem: string | null = controller.getSnapshot().problem;
controller.dispose();
${editor ? `import { CanvasEditor, type CanvasEditorProps } from '@boring/ui/canvas-editor';
import { createElement } from 'react';
declare const props: CanvasEditorProps;
createElement(CanvasEditor, props);` : ''}
`);
  // The consumer recipe sets skipLibCheck, as tldraw apps do: the pinned SDK's own declarations do not check strictly
  // (@tldraw/utils imports lodash.* whose @types it lists only as devDependencies; tldraw's ArrowShapeUtil overrides break
  // under exactOptionalPropertyTypes). The consumer's own code is still checked strictly against our declarations.
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true, noEmit: true, types: ['node'], lib: ['ES2023', 'DOM'] }, include: ['consumer.ts'] }));
  const declarations = runCaptured(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--listFiles'], { cwd: directory, timeout: 120000, env: isolated });
  process.stdout.write(declarations.stdout); process.stderr.write(declarations.stderr);
  assert.equal(declarations.status, 0, 'Canvas consumer type check failed');
  assertConsumerTypeFiles(declarations.stdout.split('\n').filter(isAbsolute).join('\n'), directory);
  // skipLibCheck must not hide errors in Boring's declarations: rerun with library checking and allow diagnostics only in tldraw's.
  const strict = runCaptured(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--skipLibCheck', 'false', '--pretty', 'false'], { cwd: directory, timeout: 120000, env: isolated });
  const located = strict.stdout.split('\n').filter(line => /^\S.*\(\d+,\d+\): error TS\d+/.test(line));
  const ours = located.filter(line => !/^node_modules\/(?:tldraw|@tldraw\/[\w-]+)\//.test(line));
  assert.deepEqual(ours, [], 'Strict library check reports errors outside the upstream tldraw declarations');
  assert.ok(strict.status === 0 || located.length > 0, `Strict library check failed without located diagnostics:\n${strict.stdout}${strict.stderr}`);
  if (located.length) console.log(`Upstream tldraw declaration diagnostics (skipLibCheck in the consumer recipe):\n${located.join('\n')}`);
  const tests = ['ui-canvas.test.mjs', 'ui-canvas-editor-lifecycle.test.mjs', ...(editor ? ['ui-canvas-editor.test.mjs'] : [])];
  // Tests are copied flat; their host (one SQLite workspace per scope, public @boring/files entries only) sits beside them.
  copyFileSync(join(root, 'examples/shared/sqlite-workspaces.mjs'), join(directory, 'sqlite-workspaces.mjs'));
  for (const name of tests) writeFileSync(join(directory, name), readFileSync(join(root, 'test/packages', name), 'utf8').replace("'../../examples/shared/sqlite-workspaces.mjs'", "'./sqlite-workspaces.mjs'"));
  run(process.execPath, ['--test', '--experimental-test-isolation=none', ...tests], isolated);
  writeFileSync(join(directory, 'browser-entry.js'), `export { createCanvasController, canvasMediaType } from '@boring/ui/canvas';\n${editor ? "export { CanvasEditor } from '@boring/ui/canvas-editor';\nimport 'tldraw/tldraw.css';\n" : ''}`);
  run(process.execPath, ['node_modules/esbuild/bin/esbuild', 'browser-entry.js', '--bundle', '--platform=browser', '--format=esm', '--outfile=browser.js', '--metafile=browser-meta.json'], isolated);
  const inputs = Object.keys(JSON.parse(readFileSync(join(directory, 'browser-meta.json'), 'utf8')).inputs);
  assertConsumerTypeFiles(inputs.map(path => resolve(directory, path)).join('\n'), directory);
  assert.ok(inputs.some(path => path.includes('@tldraw/editor/')));
  assert.ok(inputs.every(path => !/pi-durable|@earendil-works|@boring\/(agent|execution)|sqlite|node:/.test(path)), 'browser bundle must exclude kernel and server filesystem');
  assert.ok(inputs.every(path => !/@boring\/ui\/dist\/markdown(?:-editor|-parser)?\.js$|\/marked\//.test(path)), 'canvas must not load the Boring Markdown surface');
  if (editor) {
    assert.ok(inputs.some(path => /tldraw\/dist/.test(path)), 'renderer must bundle the actual native SDK');
    assert.ok(readFileSync(join(directory, 'browser.css'), 'utf8').length > 0, 'selected native CSS must build');
  }
  console.log('PASS: isolated pinned registry dependencies, packed canvas, native store/publication tests and browser bundle; browser journeys, license, real fonts/assets and migrations remain unqualified');
  console.log('PASS: canvas declarations (strict consumer code; Boring declarations library-checked; upstream tldraw declarations need skipLibCheck)');
} finally { rmSync(directory, { recursive: true, force: true }); }
