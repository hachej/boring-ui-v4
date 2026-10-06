// Guard: every HTTP handler factory reads its request body through the one shared guard, and the chat transport returns
// conversation data only through its projection chokepoint.
//
// 1. Every `export function create*Handler` in packages/*/src lives in a file that imports `request-guard` (JSON content
//    type required, body streamed under a byte cap), or carries `// request-guard: exempt (...)` and never touches a
//    request body, so the handlers cannot drift to different strictness levels again.
// 2. In chat-transport.ts, `conversation.entries(` and `submissionByRequest(` appear exactly once each, inside `reads(...)`,
//    the function that applies `access.project`; no other read op can return raw conversation data.
// 3. Node servers under examples/ never pass `Readable.toWeb(` a live request: a handler that answers without reading the
//    body cancels that stream while Node keeps writing to it, and the error kills the process. They use
//    examples/shared/node-request.mjs, which reads the body first under a byte cap.
// 4. Removed file APIs stay removed (files PR 8, "One place for files" in docs/architecture/FILES-GIT-EXEC.md): no tracked file
//    names the old SQLite resource store (`openSqliteResources` and its types or tables), the old document and artifact tools
//    (`read_document`, `save_document`, `patch_document`, `create_artifact`, `update_artifact`, `read_artifact`,
//    `list_artifacts`), the artifact `index.json` or the `/api/workspace-resources` route. Files live in a workspace behind
//    `createWorkspaceProvider`; agents use Pi's native file tools and `present`. Exempt: this file, which lists them, the
//    history section of a README headed exactly "## Migrating from the removed resource store" (the old call to new call note),
//    and `MIGRATIONS`: the Cloudflare recipe's one-time move of data its deployed objects still hold in the old tables, and the
//    test fixture that builds that old layout to prove the move. They read the old tables to rename them; nothing else may.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const REMOVED_FILE_APIS = /\b(?:openSqliteResources|SqliteResourceProvider|SqliteResourceOptions|SqliteFileResourceOptions|SqliteConnectionResourceOptions|boring_documents|boring_versions|read_document|save_document|patch_document|create_artifact|update_artifact|read_artifact|list_artifacts)\b|workspace-resources|\bindex\.json\b/g;

const HISTORY_HEADING = '## Migrating from the removed resource store';
export const MIGRATIONS = new Set(['examples/cloudflare/src/legacy-storage.mjs', 'test/fixtures/cloudflare-legacy-storage.mjs']);

/** Every tracked file (or each of `files`) that names a removed file API, as `path:line: name`. */
export function removedFileApis(root, files) {
  const listed = files ?? spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  const found = [];
  for (const path of listed) {
    if (path === 'scripts/check-handlers.mjs' || MIGRATIONS.has(path)) continue;
    let text;
    try { text = readFileSync(resolve(root, path), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    let history = false;
    text.split('\n').forEach((line, index) => {
      // The one place that may name them: a README's migration note for consumers still on the old calls.
      if (line.startsWith('## ')) history = path.endsWith('README.md') && line === HISTORY_HEADING;
      if (!history) for (const match of line.matchAll(REMOVED_FILE_APIS)) found.push(`${path}:${index + 1}: ${match[0]}`);
    });
  }
  return found;
}

const factory = /export (?:async )?function (create\w*Handler)\b/g;
const guardImport = /from '(?:@boring\/files\/request-guard|\.\/request-guard\.js)'/;
const exempt = /\/\/ request-guard: exempt \(/;
const bodyRead = /\brequest\.(?:json|text|arrayBuffer|formData|blob|body)\b/;

export function checkHandlers(root) {
  const errors = [];
  let handlers = 0;
  for (const name of readdirSync(resolve(root, 'packages'))) {
    const directory = resolve(root, 'packages', name, 'src');
    let files;
    try { files = readdirSync(directory).filter(file => file.endsWith('.ts')); } catch { continue; }
    for (const file of files) {
      const path = `packages/${name}/src/${file}`;
      const source = readFileSync(resolve(directory, file), 'utf8');
      const found = [...source.matchAll(factory)].map(match => match[1]);
      if (!found.length) continue;
      handlers += found.length;
      if (exempt.test(source)) {
        if (bodyRead.test(source)) errors.push(`BORING-HANDLER ${path}: ${found.join(', ')} is marked request-guard exempt but reads a request body`);
      } else if (!guardImport.test(source)) {
        errors.push(`BORING-HANDLER ${path}: ${found.join(', ')} must read its body through @boring/files/request-guard`);
      }
    }
  }
  // `routeSubmissions` (after the handler) looks a submission up only to return its id to the host; it is outside this rule.
  const whole = readFileSync(resolve(root, 'packages/agent/src/chat-transport.ts'), 'utf8');
  const transport = whole.slice(0, whole.indexOf('export function routeSubmissions'));
  for (const [needle, label] of [['conversation.entries(', 'conversation.entries('], ['submissionByRequest(', 'submissionByRequest(']]) {
    const count = transport.split(needle).length - 1;
    if (count !== 1) errors.push(`BORING-HANDLER chat-transport.ts: ${label} must appear exactly once, inside reads() (found ${count})`);
  }
  const reads = /function reads\([\s\S]*?\n}\n/.exec(transport)?.[0] ?? '';
  for (const needle of ['conversation.entries(', 'submissionByRequest(']) if (!reads.includes(needle)) errors.push(`BORING-HANDLER chat-transport.ts: ${needle} must be called inside reads()`);
  const walk = directory => readdirSync(directory).flatMap(entry => {
    if (entry === 'node_modules' || entry.startsWith('.')) return [];
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : /\.(mjs|js|ts)$/.test(entry) ? [path] : [];
  });
  for (const path of walk(resolve(root, 'examples'))) {
    if (path.endsWith('examples/shared/node-request.mjs')) continue;
    if (readFileSync(path, 'utf8').includes('Readable.toWeb(')) errors.push(`BORING-HANDLER ${path.slice(root.length + 1)}: use examples/shared/node-request.mjs instead of Readable.toWeb( on a live request`);
  }
  for (const hit of removedFileApis(root)) errors.push(`BORING-HANDLER ${hit} is a removed file API (use the workspace provider, Pi's file tools and present)`);
  return { errors, handlers };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkHandlers(realpathSync(fileURLToPath(new URL('../', import.meta.url))));
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
  else console.log(`ok: ${result.handlers} HTTP handler factories use the shared request guard; chat reads go through the projection chokepoint; no removed file API is named`);
}
