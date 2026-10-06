import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCaptured } from './run-captured.mjs';
import { prepareConsumerIsolation, assertConsumerTypeFiles } from './consumer-isolation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(process.argv.length, 2, 'Expected no options');
const directory = mkdtempSync(join(tmpdir(), 'boring-experience-consumer-'));
const cache = process.env.npm_config_cache;
assert.ok(cache, 'Set npm_config_cache to a writable cache containing the pinned registry archives');
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
  let filesArchive;
  for (const name of ['files', 'ui']) {
    const packed = JSON.parse(run('npm', ['pack', join(root, 'packages', name), '--json', '--ignore-scripts', '--pack-destination', join(directory, 'packs')]))[0];
    const archive = join(directory, 'packs', packed.filename);
    if (name === 'files') filesArchive = archive; else archives.push(archive);
  }
  const ui = JSON.parse(readFileSync(join(root, 'packages/ui/package.json'), 'utf8'));
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dependencies = Object.fromEntries(Object.entries(ui.peerDependencies).filter(([name]) => ['react', 'react-dom', '@json-render/core', '@json-render/react', 'zod'].includes(name)));
  for (const name of ['typescript', '@types/react', '@types/react-dom', 'happy-dom', 'esbuild']) dependencies[name] = rootManifest.devDependencies[name];
  const manifest = { name: 'isolated-experience-consumer', version: '1.0.0', private: true, type: 'module', dependencies };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  const sourceLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
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
  run('npm', ['install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, ...archives]);
  run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache]);
  for (const name of ['@boring/files', '@earendil-works/pi-durable', '@earendil-works/chord', '@boring/agent', 'tldraw', '@tldraw/editor', '@tiptap/core', 'marked', '@boring/execution']) assert.equal(existsSync(join(directory, 'node_modules', name)), false, name);
  writeFileSync(join(directory, 'consumer.ts'), `import { Experience, type RenderedExperienceCell } from '@boring/ui/experience';
import { composeExperience, validateExperience, type ExperienceDescriptor, type ExperienceCompositionOptions, type ExperienceCompositionSnapshot } from '@boring/ui/experience/compose';
import { composeExperienceRegion, type ExperienceRegionCompositionOptions } from '@boring/ui/experience/regions';
import type { Experimental_CompositionEvaluator } from '@json-render/core';
import { createElement } from 'react';
const cells: readonly RenderedExperienceCell[] = [{ ref: 'fictional/notes', kind: 'notes', version: 1, render: () => null }];
const canView = (ref: string): boolean => ref === 'fictional/notes';
declare const input: unknown;
const descriptor: ExperienceDescriptor = validateExperience(input, { cells, canView });
createElement(Experience, { descriptor, cells, canView });
declare const options: ExperienceCompositionOptions;
const evaluate: Experimental_CompositionEvaluator = options.evaluate;
const snapshots: AsyncGenerator<ExperienceCompositionSnapshot> = composeExperience({ ...options, evaluate });
declare const regionOptions: ExperienceRegionCompositionOptions;
const regionSnapshots: AsyncGenerator<ExperienceCompositionSnapshot> = composeExperienceRegion(regionOptions);
void regionSnapshots; void snapshots;
`);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['consumer.ts'] }));
  assertConsumerTypeFiles(run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--listFiles'], isolated), directory);
  const headlessTests = ['ui-experience.test.mjs', 'ui-experience-composition.test.mjs', 'ui-experience-regions.test.mjs'];
  for (const name of headlessTests) copyFileSync(join(root, 'test/packages', name), join(directory, name));
  run(process.execPath, ['--test', '--experimental-test-isolation=none', ...headlessTests], isolated);
  copyFileSync(join(root, 'examples/current-hub/fixed-view.mjs'), join(directory, 'fixed-view.mjs'));
  const bundles = [
    ['hub-view', "export { createFixtureHubView } from './fixed-view.mjs';\n"],
    ['browser', "export { Experience } from '@boring/ui/experience';\nexport { composeExperience, validateExperience } from '@boring/ui/experience/compose';\nexport { composeExperienceRegion } from '@boring/ui/experience/regions';\n"],
    ['compose', "export { composeExperience, validateExperience } from '@boring/ui/experience/compose';\nexport { composeExperienceRegion } from '@boring/ui/experience/regions';\n"],
  ];
  for (const [name, source] of bundles) {
    writeFileSync(join(directory, name + '-entry.js'), source);
    run(process.execPath, ['node_modules/esbuild/bin/esbuild', name + '-entry.js', '--bundle', '--platform=browser', '--format=esm', '--outfile=' + name + '.js', '--metafile=' + name + '-meta.json'], isolated);
    const inputs = Object.keys(JSON.parse(readFileSync(join(directory, name + '-meta.json'), 'utf8')).inputs);
    assertConsumerTypeFiles(inputs.map(path => resolve(directory, path)).join('\n'), directory);
    assert.ok(inputs.some(path => path.endsWith('@boring/ui/dist/experience-compose.js')));
    assert.ok(inputs.every(path => !/@earendil-works|@boring\/(files|agent|execution)|@tiptap|tldraw|marked|entities|sqlite|node:/.test(path)), 'Experience bundle must exclude unrelated libraries and server implementations');
    if (name === 'hub-view') assert.ok(inputs.some(path => path.endsWith('fixed-view.mjs')));
    if (name === 'compose') assert.ok(inputs.every(path => !/node_modules\/react(?:-dom)?\/|@json-render\/react\/dist\/index/.test(path)), 'Validation entry must not load the React runtime');
  }
  assert.ok(filesArchive);
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, filesArchive]);
  writeFileSync(join(directory, 'consumer.ts'), `import { createExperienceDocumentController, type ExperienceDocumentOptions, type ExperienceDocumentController } from '@boring/ui/experience/document';
import { ExperienceDocument } from '@boring/ui/experience/document-viewer';
import { createElement } from 'react';
declare const options: ExperienceDocumentOptions;
const controller: ExperienceDocumentController = createExperienceDocumentController(options);
const offered = controller.actions.propose(controller.actions.selection(), {});
if (offered.kind === 'proposed') {
  const adopted = controller.actions.adopt(offered.proposalId);
  if (adopted.kind === 'applied') controller.flush(adopted.value);
}
const request = controller.actions.beginRegion(controller.actions.selection(), 'main', 'request');
if (request.kind === 'applied') controller.actions.proposeRegion(request.value, {});
const pin = controller.getSnapshot().pin;
if (pin) controller.actions.pin(pin.selection);
controller.actions.reconcile();
const tools: undefined = controller.tools;
createElement(ExperienceDocument, { controller, cells: [], canView: () => false });
void tools;
`);
  assertConsumerTypeFiles(run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--listFiles'], isolated), directory);
  const resourceTests = ['ui-experience-viewer.test.mjs', 'ui-experience-document.test.mjs', 'ui-experience-document-viewer.test.mjs', 'ui-experience-composition-viewer.test.mjs', 'ui-experience-region-document.test.mjs', 'ui-experience-region-viewer.test.mjs'];
  // Tests are copied flat; their host (one SQLite workspace per scope, public @boring/files entries only) sits beside them.
  copyFileSync(join(root, 'examples/shared/sqlite-workspaces.mjs'), join(directory, 'sqlite-workspaces.mjs'));
  for (const name of resourceTests) writeFileSync(join(directory, name), readFileSync(join(root, 'test/packages', name), 'utf8').replace("'../../examples/shared/sqlite-workspaces.mjs'", "'./sqlite-workspaces.mjs'"));
  run(process.execPath, ['--test', '--experimental-test-isolation=none', ...resourceTests], isolated);
  writeFileSync(join(directory, 'resource-entry.js'), "export { ExperienceDocument } from '@boring/ui/experience/document-viewer';\nexport { createExperienceDocumentController } from '@boring/ui/experience/document';\n");
  run(process.execPath, ['node_modules/esbuild/bin/esbuild', 'resource-entry.js', '--bundle', '--platform=browser', '--format=esm', '--outfile=resource.js', '--metafile=resource-meta.json'], isolated);
  const resourceInputs = Object.keys(JSON.parse(readFileSync(join(directory, 'resource-meta.json'), 'utf8')).inputs);
  assertConsumerTypeFiles(resourceInputs.map(path => resolve(directory, path)).join('\n'), directory);
  assert.ok(resourceInputs.some(path => path.endsWith('@boring/ui/dist/experience-document.js')));
  assert.ok(resourceInputs.every(path => !/@earendil-works|@boring\/(agent|execution)|@tiptap|tldraw|marked|entities|sqlite|node:/.test(path)), 'Layout publication browser bundle must exclude native/server/unrelated viewer implementations');
  console.log('PASS: isolated experience declarations, public validation/native metadata and region composition without files, browser/server-safe bundles including the fixed hub view and native renderer/generated offers/conditional Keep and region Pin with borrowed SQLite document controllers; no browser journey claimed');
} finally { rmSync(directory, { recursive: true, force: true }); }
