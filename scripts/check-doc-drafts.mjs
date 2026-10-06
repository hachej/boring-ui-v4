// Guard: a native document draft (`await tx.doc(...)`) records only writes made through the draft itself. Assigning a fresh object
// and writing into the value the assignment returns loses those writes, with no error:
//   (draft.map ??= {})[key] = value;          // lost
//   const map = draft.map ??= {}; map[key] = v; // lost
// Write `draft.map ??= {};` and then read `draft.map` again before writing into it. Files that open document drafts must not
// contain the lossy forms.
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skip = new Set(['node_modules', 'dist', '.cache', '.wrangler', 'out']);
const sourceFile = /\.(?:ts|tsx|mjs|js|jsx)$/;
const opensDraft = /\btx\.doc\(/;
const lossy = [
  /\(\s*[\w$]+(?:\.[\w$]+)+\s*\?\?=\s*(?:\{\}|\[\])\s*\)\s*[[.]/g,
  /=\s*[\w$]+(?:\.[\w$]+)+\s*\?\?=\s*(?:\{\}|\[\])/g,
];

export function checkDocDrafts(root) {
  const errors = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile() || !sourceFile.test(entry.name)) continue;
      const text = readFileSync(path, 'utf8');
      if (!opensDraft.test(text)) continue;
      for (const pattern of lossy) for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        errors.push(`BORING-DOC-DRAFT ${relative(root, path)}:${line}: a write into the value of \`??=\` bypasses the document draft; assign, then re-read the field`);
      }
    }
  };
  for (const directory of ['packages', 'examples']) walk(resolve(root, directory));
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const errors = checkDocDrafts(resolve(fileURLToPath(new URL('..', import.meta.url))));
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('document draft writes: ok');
}
