import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { registrySchema, registryItemSchema } from 'shadcn/schema';
import { runCaptured } from '../../scripts/run-captured.mjs';
import { viewersCss } from '../../registry/viewers/build-css.mjs';
import { feedbackCss } from '../../scripts/build-feedback-css.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Items written in Tailwind, installed into their own folder, rather than recipes over a headless @boring/ui controller.
const manifest = registrySchema.parse(JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')));
// Tailwind items bring owned source with shadcn tokens: every rule is scoped to the item's root class and lives in the base or components layer.
const TAILWIND = { 'pi-chat': { scope: '.pi-chat', keyframes: /^@keyframes pi-chat-/, folder: 'pi-chat' }, 'pi-ambient': { scope: '.pi-chat', keyframes: /^@keyframes pi-ambient-/, folder: 'pi-ambient' }, 'pi-workspace': { scope: '.pi-chat', keyframes: /^@keyframes pi-workspace-/, folder: 'pi-workspace' }, viewers: { scope: '.boring-viewer', keyframes: /^@keyframes boring-viewer-/, folder: 'viewers' }, 'provider-setup': { scope: '.provider-setup', keyframes: /^@keyframes provider-setup-/, folder: 'provider-setup' } };
// The feedback item imports the package's browser entries directly (no copied validators), React and React DOM (a portal); nothing from store, agent or source.
const FEEDBACK_IMPORTS = new Set(['react', 'react-dom', '@boring/feedback/format', '@boring/feedback/page', '@boring/feedback/ui', '@boring/feedback/preview']);

test('standard pinned CLI rebuilds the committed source registry artifact exactly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boring-registry-build-'));
  try {
    const cli = createRequire(import.meta.url).resolve('shadcn');
    const result = runCaptured(process.execPath, [cli, 'build', 'registry.json', '--output', directory], { cwd: root, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'registry.json'), 'utf8')), JSON.parse(readFileSync(join(root, 'public/r/registry.json'), 'utf8')));
    for (const item of manifest.items) {
      const built = registryItemSchema.parse(JSON.parse(readFileSync(join(directory, item.name + '.json'), 'utf8')));
      const committed = JSON.parse(readFileSync(join(root, 'public/r', item.name + '.json'), 'utf8'));
      assert.deepEqual(built, registryItemSchema.parse(committed), 'Generated item is stale or differs from the real CLI');
      for (const file of built.files) assert.equal(file.content, readFileSync(join(root, file.path), 'utf8'));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('registry dependency pins and scoped styles preserve the declared source distribution boundary', () => {
  const architecture = JSON.parse(readFileSync(join(root, 'ARCHITECTURE.json'), 'utf8'));
  const ui = JSON.parse(readFileSync(join(root, 'packages/ui/package.json'), 'utf8'));
  const boringVersion = name => JSON.parse(readFileSync(join(root, 'packages', name.slice('@boring/'.length), 'package.json'), 'utf8')).version;
  assert.equal(architecture.sourceDistribution.manifest, 'registry.json');
  assert.equal(architecture.sourceDistribution.format, 'shadcn@' + architecture.rootDevDependencies.shadcn);
  for (const item of manifest.items) {
    const declared = new Set();
    for (const dependency of item.dependencies) {
      const split = dependency.lastIndexOf('@'), name = dependency.slice(0, split), version = dependency.slice(split + 1);
      assert.match(version, /^\d+\.\d+\.\d+$/);
      declared.add(name);
      // Items that bring their own Tailwind source pin extra packages exactly as the repository's root tooling does.
      const expected = name.startsWith('@boring/') ? boringVersion(name) : name === '@modelcontextprotocol/sdk' || item.name in TAILWIND && architecture.rootDevDependencies[name] ? architecture.rootDevDependencies[name] : ui.peerDependencies[name];
      assert.equal(version, expected, dependency);
    }
    // Blocks may depend only on other items of this registry (pi-ambient and pi-workspace build on pi-chat); nothing from a remote registry.
    for (const dependency of item.registryDependencies ?? []) assert.ok(manifest.items.some(other => '@boring-ui/' + other.name === dependency), 'No implicit unpinned child items: ' + dependency);
    assert.equal(item.cssVars, undefined, 'No registry theme replacement');
    if (item.name in TAILWIND) {
      const { scope, keyframes, folder } = TAILWIND[item.name];
      // Layered base/component rules scoped to the item's root class, plus prefixed keyframes. Never a root, html or body rule.
      const scoped = (rules, where) => { for (const [key, value] of Object.entries(rules)) {
        if (typeof value === 'object' && /^@(media|container|supports)\b/.test(key)) { scoped(value, where + ' ' + key); continue; }
        for (const part of key.split(/,(?![^(]*\))/)) assert.ok(part.trim().startsWith(scope), where + ': ' + key);
      } };
      for (const [at, rules] of Object.entries(item.css ?? {})) {
        if (at.startsWith('@keyframes ')) { assert.match(at, keyframes); continue; }
        assert.match(at, /^@layer (base|components)$/);
        scoped(rules, at);
      }
      if (item.name === 'viewers') assert.deepEqual(item.css, viewersCss(), 'registry.json css differs from registry/viewers/viewers.css: run node registry/viewers/build-css.mjs');
      const names = new Set(item.files.map(file => file.path.replace(new RegExp('^registry/' + folder + '/'), '')));
      for (const file of item.files) {
        assert.match(file.target, new RegExp('^components/' + folder + '/'), 'files install into their own folder, never over the host\'s button or utils');
        const source = readFileSync(join(root, file.path), 'utf8');
        for (const imported of [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match => match[1])) {
          if (imported.startsWith('./')) { assert.ok([...names].some(name => name.replace(/\.tsx?$/, '') === imported.slice(2)), `${file.path} imports missing ${imported}`); continue; }
          // A block imports the item it depends on by its installed sibling folder (`../pi-chat/utils`); scripts/check-registry-blocks.mjs enforces the direction.
          const sibling = /^\.\.\/([\w-]+)\/([\w-]+)$/.exec(imported);
          if (sibling) { const other = manifest.items.find(entry => entry.name === sibling[1]); assert.ok(other && (item.registryDependencies ?? []).includes('@boring-ui/' + other.name) && other.files.some(entry => entry.path.replace(/\.tsx?$/, '') === `registry/${other.name}/${sibling[2]}`), `${file.path} imports ${imported} outside its registryDependencies`); continue; }
          if (architecture.sourceDistribution.runtimeImports.includes(imported)) continue;
          const pkg = imported.startsWith('@') ? imported.split('/').slice(0, 2).join('/') : imported.split('/')[0];
          assert.ok(declared.has(pkg), `${file.path} imports ${imported} which the item does not declare`);
          assert.ok(!/^(ai|@ai-sdk\/.*)$/.test(pkg), 'No AI SDK');
        }
        assert.doesNotMatch(source, /dangerouslySetInnerHTML|eval\s*\(|new Function|<script\b/);
      }
      continue;
    }
    if (item.name === 'feedback' || item.name === 'feedback-preview') {
      if (item.name === 'feedback-preview') assert.equal(item.css, undefined, 'the banner is styled by the feedback item');
      else assert.ok(!item.dependencies.some(name => name.startsWith('@earendil-works/pi-ai')), 'annotation-only feedback must not install the model SDK');
      if (item.name === 'feedback') assert.deepEqual(item.css, feedbackCss(), 'registry.json css differs from registry/feedback/feedback.css: run node scripts/build-feedback-css.mjs');
      const scoped = (rules, where) => { for (const [key, value] of Object.entries(rules)) {
        if (/^@(media|container|supports)\b/.test(key)) { scoped(value, where + ' ' + key); continue; }
        for (const part of key.split(/,(?![^(]*\))/)) assert.ok(part.trim().startsWith('[data-boring="feedback"]'), where + ': ' + key);
      } };
      if (item.name === 'feedback') scoped(item.css, 'feedback');
      assert.ok(declared.has('@boring/feedback'));
      const names = item.files.map(file => file.path.replace(/^registry\/feedback\//, '').replace(/\.tsx?$/, ''));
      for (const file of item.files) {
        assert.match(file.target, /^components\/feedback\//, 'files install into their own folder');
        const source = readFileSync(join(root, file.path), 'utf8');
        for (const imported of [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match => match[1])) {
          if (imported.startsWith('./')) { assert.ok(names.includes(imported.slice(2)), `${file.path} imports missing ${imported}`); continue; }
          assert.ok(FEEDBACK_IMPORTS.has(imported), `${file.path} imports ${imported}: only React, React DOM and @boring/feedback/format, /page, /ui and /preview`);
        }
        // Masking, picking, anchoring and placement stay in the package: no copied serializer, policy or resolver.
        assert.doesNotMatch(source, /function\s+(parseFeedback|checkFeedback|serializePage|createPrivacyPolicy|anchorOf|resolveAppElement|maskText)\b|elementsFromPoint|getAttribute\(/);
        assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|eval\s*\(|new Function|<script\b/);
      }
      continue;
    }
    const prefix = { 'markdown-editor': '.boring-markdown-recipe[data-boring=\"markdown-editor\"]', chat: '.boring-chat-recipe[data-boring=\"chat\"]', 'html-viewer': '.boring-html-recipe[data-boring=\"html-viewer\"]' }[item.name];
    assert.ok(prefix);
    for (const selector of Object.keys(item.css)) {
      for (const part of selector.split(',')) assert.ok(part.trim().startsWith(prefix), selector);
    }
    for (const file of item.files) {
      const source = readFileSync(join(root, file.path), 'utf8');
      const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
      assert.ok(imports.length > 0);
      for (const imported of imports) assert.ok(architecture.sourceDistribution.runtimeImports.includes(imported), imported);
      assert.doesNotMatch(source, /dangerouslySetInnerHTML|eval\s*\(|new Function|<script\b/);
    }
  }
});
