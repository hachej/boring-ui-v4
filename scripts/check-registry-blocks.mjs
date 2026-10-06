// Guard: registry items are blocks with one direction of dependency.
//
// 1. Every source file under registry/<item>/ is listed in that item of registry.json (nothing ships by accident or is
//    imported by path from outside the item).
// 2. A file may import another item (`../<item>/<file>`) only when that item is in its own item's registryDependencies
//    (transitively) and lists the file. pi-chat declares none, so the chat never imports pi-ambient or pi-workspace, and
//    pi-workspace never imports pi-ambient (the host swaps AmbientChat in when the chat floats).
// 3. Declared registryDependencies name items of this registry.
// 4. File types and targets: a `use*.ts` file is `registry:hook`, any other `.ts` is `registry:lib` (or a declared `registry:hook`), a
//    `.tsx` is a component (`registry:ui` for a shared primitive such as the button); every file has the target
//    `components/<item>/<file>`, so the installed folders mirror registry/ and the sibling imports above resolve.
// 5. No file name is shipped by two items: a shared helper is one item (utils, button) that the others depend on.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = /\.(?:tsx?|jsx?|mjs)$/;
/** registryDependencies use the namespace the consumer maps in components.json (`"registries": { "@boring-ui": "<served public/r>/{name}.json" }`). */
const namespace = '@boring-ui/';
const local = (dependency) => dependency.startsWith(namespace) ? dependency.slice(namespace.length) : dependency;
const importPattern = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

export function checkRegistryBlocks(root) {
  const errors = [];
  const manifest = JSON.parse(readFileSync(resolve(root, 'registry.json'), 'utf8'));
  const items = new Map(manifest.items.map((item) => [item.name, item]));
  const listed = (item) => new Set(item.files.map((file) => file.path));
  const closure = (name, seen = new Set()) => {
    for (const dependency of (items.get(name)?.registryDependencies ?? []).map(local)) if (!seen.has(dependency)) { seen.add(dependency); closure(dependency, seen); }
    return seen;
  };
  let files = 0;
  const owners = new Map();
  for (const item of items.values()) {
    for (const dependency of item.registryDependencies ?? []) if (!dependency.startsWith(namespace) || !items.has(local(dependency))) errors.push(`BORING-BLOCKS ${item.name}: registryDependencies must be ${namespace}<item of this registry> (found ${dependency})`);
    for (const file of item.files ?? []) {
      const base = posix.basename(file.path);
      const where = `BORING-BLOCKS ${file.path}`;
      if (file.target !== `components/${item.name}/${base}` || file.path !== `registry/${item.name}/${base}`) errors.push(`${where}: lives in registry/${item.name}/ and installs to components/${item.name}/${base} (target ${file.target ?? 'missing'})`);
      if (/^use[A-Z-].*\.ts$/.test(base) && file.type !== 'registry:hook') errors.push(`${where}: a use*.ts file is registry:hook (found ${file.type})`);
      else if (/\.ts$/.test(base) && file.type !== 'registry:lib' && file.type !== 'registry:hook') errors.push(`${where}: a .ts helper is registry:lib (found ${file.type})`);
      else if (/\.tsx$/.test(base) && file.type !== 'registry:component' && file.type !== 'registry:ui') errors.push(`${where}: a .tsx file is registry:component or registry:ui (found ${file.type})`);
      if (owners.has(base)) errors.push(`${where}: ${base} is also shipped by item ${owners.get(base)}; share one item instead`);
      else owners.set(base, item.name);
    }
  }
  for (const directory of readdirSync(resolve(root, 'registry'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const item = items.get(directory.name);
    if (!item) { errors.push(`BORING-BLOCKS registry/${directory.name}: directory is not an item of registry.json`); continue; }
    const own = listed(item);
    const allowed = closure(item.name);
    for (const name of readdirSync(resolve(root, 'registry', directory.name))) {
      const path = `registry/${directory.name}/${name}`;
      if (!source.test(name)) continue;
      files += 1;
      const text = readFileSync(resolve(root, path), 'utf8');
      // build-css.mjs and similar tooling stay in the folder but ship nothing; only files that import or are imported matter for the item's code.
      if (!own.has(path) && !/\.mjs$/.test(name)) errors.push(`BORING-BLOCKS ${path}: not listed in item ${item.name} of registry.json`);
      for (const [, specifier] of text.matchAll(importPattern)) {
        if (!specifier.startsWith('.')) continue;
        const target = posix.normalize(posix.join('registry', directory.name, specifier));
        const match = /^registry\/([^/]+)\/([^/]+)$/.exec(target);
        if (!match) { errors.push(`BORING-BLOCKS ${path}: import ${specifier} leaves the registry folders`); continue; }
        const [, other, base] = match;
        if (other === directory.name) continue;
        const file = [...items.get(other)?.files ?? []].map((entry) => entry.path).find((entry) => entry.replace(/\.[^.]+$/, '') === `registry/${other}/${base}`);
        if (!items.has(other) || !allowed.has(other)) errors.push(`BORING-BLOCKS ${path}: imports ${specifier} from item ${other}, which ${item.name} does not depend on (registryDependencies)`);
        else if (!file) errors.push(`BORING-BLOCKS ${path}: imports ${specifier}, which item ${other} does not list`);
      }
    }
    for (const file of own) if (!existsSync(resolve(root, file))) errors.push(`BORING-BLOCKS ${item.name}: listed file ${file} does not exist`);
  }
  return { errors, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkRegistryBlocks(realpathSync(fileURLToPath(new URL('../', import.meta.url))));
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
  else console.log(`ok: ${result.files} registry source files are listed in their item with their type and target, and import only items they depend on`);
}
