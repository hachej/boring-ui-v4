// Tailwind v4 for the studio, compiled once at startup with the library API (no CLI, no PostCSS, no config file).
// Utilities are generated for every class-like token found in the chat and viewers registry source and the studio itself.
// Only the theme and utilities layers are loaded: Tailwind's preflight would restyle the viewer panels, so the
// chat item brings its own scoped base rules (see its `css` in registry.json).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);

function files(directory, pattern) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? (name === 'out' ? [] : files(path, pattern)) : pattern.test(name) ? [path] : [];
  });
}

/** The shadcn registry item's `css` object as CSS text (nested at-rules and keyframes included). */
export function registryCss(item) {
  const render = (rules, depth = 0) => Object.entries(rules).map(([selector, value]) => typeof value === 'object'
    ? `${selector}{${render(value, depth + 1)}}` : `${selector}:${value};`).join(depth === 0 ? '\n' : '');
  return render(item.css ?? {});
}

/** Candidates are any run of non-space, non-quote characters: Tailwind ignores those that are not utilities. */
function candidates(paths) {
  const found = new Set();
  for (const path of paths) for (const token of readFileSync(path, 'utf8').split(/[\s"'`]+/)) if (token) found.add(token);
  return [...found];
}

/** `extraDirectories` are more folders (relative to the repository root) to scan for classes, such as other registry items. */
export async function buildTailwind({ themeCss, extraDirectories = [] }) {
  const items = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')).items.filter(entry => ['pi-chat', 'pi-ambient', 'pi-workspace', 'viewers'].includes(entry.name));
  const input = `@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
${themeCss}
${items.map(registryCss).join('\n')}`;
  const compiler = await compile(input, {
    base: root,
    onDependency: () => {},
    loadStylesheet: async id => {
      const resolved = id === 'tailwindcss' ? join(dirname(require.resolve('tailwindcss/package.json')), 'index.css') : require.resolve(id);
      return { path: resolved, base: dirname(resolved), content: readFileSync(resolved, 'utf8') };
    },
    loadModule: async () => { throw new Error('Tailwind plugins and configs are not used in the studio'); },
  });
  const sources = [...['registry/pi-chat', 'registry/pi-ambient', 'registry/pi-workspace', 'registry/viewers', ...extraDirectories].flatMap(directory => files(join(root, directory), /\.(tsx?|css)$/)), ...files(join(root, 'examples/studio'), /\.(jsx|mjs|css)$/).filter(path => !path.endsWith('tailwind.mjs'))];
  return compiler.build(candidates(sources));
}
