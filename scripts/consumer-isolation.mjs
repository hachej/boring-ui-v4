import { realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Parent dependencies can hide an incomplete tarball or registry recipe. */
export function prepareConsumerIsolation(directory) {
  const root = realpathSync(directory);
  const path = join(root, 'dependency-boundary.mjs');
  writeFileSync(path, `import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = ${JSON.stringify(root + sep)};
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (result.url.startsWith('file:') && !realpathSync(fileURLToPath(result.url)).startsWith(root)) throw new Error('Consumer dependency escaped installation: ' + result.url);
  return result;
} });
`);
  return { ...process.env, NODE_OPTIONS: `--import=${path}` };
}

export function assertConsumerTypeFiles(output, directory) {
  const root = realpathSync(directory);
  const files = output.trim().split('\n');
  if (!files.length || files.some(path => {
    if (!isAbsolute(path)) return true;
    const location = relative(root, realpathSync(path));
    return location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location);
  })) {
    throw new Error('Consumer declarations resolved outside their installation');
  }
}
