import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCaptured } from './run-captured.mjs';
import { prepareConsumerIsolation, assertConsumerTypeFiles } from './consumer-isolation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--html', 'Expected no option or --html');
const html = process.argv[2] === '--html';
const recipe = html ? { name: 'html-viewer', exportName: 'HtmlViewer', className: 'boring-html-recipe', hostClass: 'host-installed-html', radius: '--boring-html-radius', fixture: 'registry-html.mjs' }
  : { name: 'markdown-editor', exportName: 'MarkdownEditor', className: 'boring-markdown-recipe', hostClass: 'host-installed-editor', radius: '--boring-editor-radius', fixture: 'registry-markdown.mjs' };
const item = JSON.parse(readFileSync(join(root, 'public/r', recipe.name + '.json'), 'utf8'));
const excludedPackages = ['@earendil-works/pi-durable', '@earendil-works/chord', '@boring/agent', 'tldraw', '@tldraw/editor', ...(html ? ['@tiptap/core', 'marked', '@boring/execution'] : [])];
const temporary = mkdtempSync(join(tmpdir(), 'boring-registry-consumer-'));
// The pinned native SDK probes ten ancestor node_modules paths even when local types exist.
const directory = temporary;
mkdirSync(directory, { recursive: true });
const cache = process.env.npm_config_cache;
assert.ok(cache, 'Set npm_config_cache to a writable cache containing the pinned registry archives');
function run(command, args, env) {
  const result = runCaptured(command, args, { cwd: directory, timeout: 120000, ...(env ? { env } : {}) });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `${command} failed: ${result.error?.message ?? result.signal ?? result.status}`);
  return result.stdout;
}
let completed = false;
try {
  const isolated = prepareConsumerIsolation(directory);
  mkdirSync(join(directory, 'packs'));
  const archives = [], archiveByName = new Map();
  for (const pin of item.dependencies.filter(pin => pin.startsWith('@boring/'))) {
    const name = pin.slice('@boring/'.length, pin.lastIndexOf('@'));
    const packed = JSON.parse(run('npm', ['pack', join(root, 'packages', name), '--json', '--ignore-scripts', '--pack-destination', join(directory, 'packs')]))[0];
    const path = join(directory, 'packs', packed.filename);
    archives.push(path); archiveByName.set(packed.name, path);
  }
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const sourceLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const dependencies = Object.fromEntries(item.dependencies.filter(pin => !pin.startsWith('@boring/')).map(pin => {
    const split = pin.lastIndexOf('@'); return [pin.slice(0, split), pin.slice(split + 1)];
  }));
  for (const name of ['typescript', '@types/react', '@types/react-dom', 'happy-dom', 'esbuild', 'shadcn', 'tailwindcss']) dependencies[name] = rootManifest.devDependencies[name];
  const manifest = { name: 'isolated-registry-consumer', version: '1.0.0', private: true, type: 'module', dependencies };
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
  run('npm', ['install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, ...archives]);
  run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache]);
  for (const name of excludedPackages) assert.equal(existsSync(join(directory, 'node_modules', name)), false, name);
  const localItem = structuredClone(item);
  const expectedVersions = new Map();
  localItem.dependencies = item.dependencies.map(pin => {
    const split = pin.lastIndexOf('@'), name = pin.slice(0, split), version = pin.slice(split + 1);
    assert.match(version, /^\d+\.\d+\.\d+$/);
    expectedVersions.set(name, version);
    let bytes;
    if (name.startsWith('@boring/')) {
      const archive = archiveByName.get(name);
      assert.ok(archive); bytes = readFileSync(archive);
    } else {
      const entry = sourceLock.packages['node_modules/' + name];
      assert.equal(entry.version, version);
      assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
      const [algorithm, encoded] = entry.integrity.split('-');
      assert.equal(algorithm, 'sha512');
      const digest = Buffer.from(encoded, 'base64').toString('hex');
      bytes = readFileSync(join(cache, '_cacache/content-v2/sha512', digest.slice(0, 2), digest.slice(2, 4), digest.slice(4)));
      assert.equal(createHash('sha512').update(bytes).digest('base64'), encoded, name + ' archive integrity');
    }
    const archive = join(directory, 'packs', createHash('sha256').update(bytes).digest('hex') + '.tgz');
    writeFileSync(archive, bytes);
    const archived = JSON.parse(run('tar', ['-xOf', archive, 'package/package.json']));
    assert.equal(archived.name, name); assert.equal(archived.version, version);
    return name + '@file:' + archive;
  });
  const unchanged = structuredClone(localItem); unchanged.dependencies = item.dependencies;
  assert.deepEqual(unchanged, item);
  writeFileSync(join(directory, recipe.name + '.json'), JSON.stringify(localItem));
  for (const path of ['src', 'test/fixtures', 'dist']) mkdirSync(join(directory, path), { recursive: true });
  writeFileSync(join(directory, 'components.json'), JSON.stringify({ $schema: 'https://ui.shadcn.com/schema.json', style: 'new-york', rsc: false, tsx: true, tailwind: { config: '', css: 'src/index.css', baseColor: '', cssVariables: true, prefix: '' }, iconLibrary: 'lucide', aliases: { components: '@/components', utils: '@/lib/utils', ui: '@/components/ui', lib: '@/lib', hooks: '@/hooks' } }));
  writeFileSync(join(directory, 'src/index.css'), '');
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'], baseUrl: '.', paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.tsx', 'consumer.ts'] }));
  const installer = { ...process.env, npm_config_cache: cache, npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  delete installer.NODE_OPTIONS;
  run(process.execPath, ['node_modules/shadcn/dist/index.js', 'add', join(directory, recipe.name + '.json'), '--cwd', directory, '--yes'], installer);
  for (const [name, version] of Object.entries(dependencies)) expectedVersions.set(name, version);
  for (const name of excludedPackages) assert.equal(existsSync(join(directory, 'node_modules', name)), false, name);
  for (const [name, version] of expectedVersions) {
    const installed = JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(installed.name, name); assert.equal(installed.version, version);
  }
  const component = 'src/components/' + recipe.name + '.tsx';
  assert.ok(existsSync(join(directory, component)), 'Real CLI must create the wrapper');
  assert.ok(readFileSync(join(directory, component), 'utf8').includes('@boring/ui/' + recipe.name));
  assert.ok(readFileSync(join(directory, 'src/index.css'), 'utf8').includes(recipe.className));
  writeFileSync(join(directory, 'consumer.ts'), html ? `import { HtmlViewer, type HtmlViewerProps } from './src/components/html-viewer';
import type { HtmlController } from '@boring/ui/html';
import { createElement } from 'react';
declare const controller: HtmlController;
const props: HtmlViewerProps = { controller, title: 'Fictional registry HTML' };
createElement(HtmlViewer, props);
controller.flush(controller.actions.selection());
controller.actions.reconcile();
` : `import { MarkdownEditor, type MarkdownEditorProps } from './src/components/markdown-editor';
import type { MarkdownController } from '@boring/ui/markdown';
import { createElement } from 'react';
declare const controller: MarkdownController;
const props: MarkdownEditorProps = { controller, title: 'Fictional registry document', onMountedTools: tools => {
  const target = tools?.getTarget();
  if (!tools || !target) return;
  const expiresAt = Date.now() + 1000;
  void tools.inspect.invoke(target, { expiresAt }).then(result => {
    if (result.kind === 'applied') { const dirty: boolean = result.value.dirty; void dirty; }
  });
  void tools.revealHeading.invoke(target, { expiresAt, index: 0 });
  void tools.select.invoke(target, { expiresAt, selection: { kind: 'rich', anchor: 1, head: 1 } });
  void tools.select.invoke(target, { expiresAt, selection: { kind: 'source', start: 0, end: 1, direction: 'backward' } });
} };
createElement(MarkdownEditor, props);
controller.flush(controller.actions.selection());
`);
  const compile = () => {
    assertConsumerTypeFiles(run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--listFiles'], isolated), directory);
    run(process.execPath, ['node_modules/esbuild/bin/esbuild', component, '--format=esm', '--jsx=automatic', '--outfile=dist/' + recipe.name + '.js'], isolated);
  };
  copyFileSync(join(root, 'test/fixtures', recipe.fixture), join(directory, 'test/fixtures', recipe.fixture));
  // The tests' host: one SQLite workspace per scope over the installed @boring/files (public entry points only).
  mkdirSync(join(directory, 'examples/shared'), { recursive: true });
  copyFileSync(join(root, 'examples/shared/sqlite-workspaces.mjs'), join(directory, 'examples/shared/sqlite-workspaces.mjs'));
  if (!html) {
    const proposals = readFileSync(join(root, 'test/packages/ui-markdown-proposals.test.mjs'), 'utf8');
    assert.equal(proposals.split("'@boring/ui/markdown-editor'").length, 2);
    writeFileSync(join(directory, 'test/fixtures/registry-markdown-proposals-dom.mjs'), proposals.replace("'@boring/ui/markdown-editor'", "'../../dist/markdown-editor.js'"));
    const tests = readFileSync(join(root, 'test/packages/ui-markdown-mounted.test.mjs'), 'utf8');
    assert.equal(tests.split("'@boring/ui/markdown-editor'").length, 2);
    writeFileSync(join(directory, 'test/fixtures/registry-markdown-mounted-dom.mjs'), tests.replace("'@boring/ui/markdown-editor'", "'../../dist/markdown-editor.js'"));
  }
  if (html) {
    const tests = readFileSync(join(root, 'test/packages/ui-html-viewer.test.mjs'), 'utf8');
    assert.equal(tests.split("'@boring/ui/html-viewer'").length, 2);
    writeFileSync(join(directory, 'test/fixtures/registry-html-dom.mjs'), tests.replace("'@boring/ui/html-viewer'", "'../../dist/html-viewer.js'"));
  }
  compile();
  run(process.execPath, ['--test', '--experimental-test-isolation=none', 'test/fixtures/' + recipe.fixture, ...(!html ? ['test/fixtures/registry-markdown-mounted-dom.mjs', 'test/fixtures/registry-markdown-proposals-dom.mjs'] : [])], isolated);
  const copied = readFileSync(join(directory, component), 'utf8');
  assert.ok(copied.includes(recipe.className));
  writeFileSync(join(directory, component), copied.replace(recipe.className, recipe.className + ' ' + recipe.hostClass));
  writeFileSync(join(directory, 'src/index.css'), readFileSync(join(directory, 'src/index.css'), 'utf8') + `\n.${recipe.hostClass} { ${recipe.radius}: 1.25rem; }\n`);
  compile();
  run(process.execPath, ['--test', '--experimental-test-isolation=none', 'test/fixtures/' + recipe.fixture, ...(!html ? ['test/fixtures/registry-markdown-mounted-dom.mjs', 'test/fixtures/registry-markdown-proposals-dom.mjs'] : [])], { ...isolated, BORING_REGISTRY_RESTYLED: 'true' });
  const controllerExport = html ? 'createHtmlController' : 'createMarkdownController';
  const controllerEntry = html ? 'html' : 'markdown';
  writeFileSync(join(directory, 'browser-entry.js'), `export { ${recipe.exportName} } from './${component}';\nexport { ${controllerExport} } from '@boring/ui/${controllerEntry}';\nimport './src/index.css';\n`);
  run(process.execPath, ['node_modules/esbuild/bin/esbuild', 'browser-entry.js', '--bundle', '--platform=browser', '--format=esm', '--outfile=browser.js', '--metafile=browser-meta.json'], isolated);
  const inputs = Object.keys(JSON.parse(readFileSync(join(directory, 'browser-meta.json'), 'utf8')).inputs);
  assertConsumerTypeFiles(inputs.map(path => resolve(directory, path)).join('\n'), directory);
  assert.ok(inputs.some(path => path.endsWith(component)), 'Bundle must use CLI-installed copied source');
  assert.ok(inputs.some(path => path.endsWith('@boring/ui/dist/' + controllerEntry + '.js')), 'Bundle must include the selected public controller');
  assert.ok(inputs.every(path => !/pi-durable|@earendil-works|@boring\/agent|sqlite|node:|tldraw/.test(path)), 'browser bundle must exclude kernel/server/canvas');
  if (html) assert.ok(inputs.every(path => !/@tiptap|marked|entities|@boring\/execution/.test(path)), 'HTML bundle must exclude unrelated viewers and execution');
  console.log('PASS: real pinned shadcn local installation of ' + recipe.name + ', strict declarations, copied-source restyle and real controller operations; DOM and bundle evidence only');
  completed = true;
} finally {
  if (completed) rmSync(temporary, { recursive: true, force: true });
  else console.error('Retained failing disposable registry consumer at ' + directory);
}
