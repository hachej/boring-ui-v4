import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = [
  'README.md', 'AGENTS.md', 'INVARIANTS.md', 'ARCHITECTURE.json', 'VERIFY.json',
  'docs/LAWS.md', 'docs/architecture/PI-COMPLEMENT.md', 'docs/compatibility/HUB-M1.md',
  'docs/architecture/SPEC.md',
  'docs/architecture/PRODUCT-REQUIREMENTS.md', 'docs/architecture/ROADMAP.md',
  'docs/architecture/CANVAS.md', 'docs/architecture/FILES-GIT-EXEC.md',
  'docs/architecture/WEBSITE-INTEGRATION.md', 'docs/architecture/UPSTREAM-EXAMPLES.md',
  'docs/architecture/EXPERIENCE.md',
  'docs/contracts/CONTRACTS.md', 'docs/acceptance/ACCEPTANCE.md',
  'docs/stress-tests/REDACTION.md', 'docs/stress-tests/BASELINE.md', 'docs/stress-tests/HUB-FACTORY.md',
];
// `.claude/worktrees` holds other checkouts of this repository (agent worktrees), not documents of this one.
const ignored = new Set(['.git', '.cache', 'node_modules']);
const ignoredPaths = ['.claude/worktrees'];
const outside = (root, target) => {
  const path = relative(root, target);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
};

export function checkDocs(directory, expected = required) {
  const root = realpathSync(directory);
  const problems = [];
  let documents = 0;
  for (const path of expected) {
    if (!existsSync(resolve(root, path))) problems.push(`missing required document: ${path}`);
  }
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { if (!ignoredPaths.some(skip => path === resolve(root, skip))) walk(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      documents++;
      const text = readFileSync(path, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
      for (const match of text.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
        const link = match[1];
        if (/^(?:https?:|mailto:|#)/i.test(link)) continue;
        const target = resolve(directory, link.split('#')[0]);
        if (outside(root, target) || (existsSync(target) && outside(root, realpathSync(target)))) {
          problems.push(`${relative(root, path)}: link leaves repository: ${link}`);
        } else if (!existsSync(target)) {
          problems.push(`${relative(root, path)}: missing local link target: ${link}`);
        }
      }
    }
  };
  walk(root);
  return { documents, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = checkDocs(root);
  if (result.problems.length) {
    console.error(result.problems.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`ok: ${result.documents} documents; required files and local links resolve`);
    console.log('Scope: document structure only, not runtime/type/security/acceptance verification.');
  }
}
