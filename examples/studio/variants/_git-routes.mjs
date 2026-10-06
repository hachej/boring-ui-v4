// The Git tab's endpoints for a variant whose workspace is a repository: log, status, tracked files and one file's text,
// all read from the same repository instance the agent's working_git tool uses.
import { posix } from 'node:path';

const STATES = { '0,2,0': 'untracked', '0,2,2': 'added', '0,2,3': 'added', '1,2,1': 'modified', '1,2,2': 'modified', '1,2,3': 'modified', '1,0,1': 'deleted', '1,0,0': 'deleted', '1,1,0': 'deleted' };

export function gitRoutes({ repository, fs, root, walk, env, context }) {
  // The repository service has no "current branch" call, so read HEAD from the same filesystem.
  const branch = async () => { const head = (await fs.readFile(`${root}/.git/HEAD`)).trim(); return head.startsWith('ref: refs/heads/') ? head.slice(16) : `detached ${head.slice(0, 7)}`; };
  const inside = path => typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.git' || part === '');
  return async function routes(request, url) {
    if (request.method !== 'GET') return undefined;
    switch (url.pathname) {
      case '/api/variant/git/log': return Response.json({ branch: await branch(), branches: await repository.branches(),
        commits: (await repository.log()).map(entry => ({ oid: entry.oid, message: entry.commit.message.trim(), author: entry.commit.author.name, timestamp: entry.commit.author.timestamp })) });
      case '/api/variant/git/status': return Response.json({ branch: await branch(), changes: (await repository.status())
        .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
        .map(([path, head, workdir, stage]) => ({ path, state: STATES[`${head},${workdir},${stage}`] ?? 'changed', staged: stage !== head && !(head === 0 && stage === 0) })) });
      case '/api/variant/git/files': {
        const files = [];
        await walk(root, (path, _stat, directory) => { const relative = posix.relative(root, path); if (!directory && inside(relative)) files.push(relative); });
        return Response.json({ files });
      }
      case '/api/variant/git/file': {
        const path = url.searchParams.get('path') ?? '';
        if (!inside(path)) return Response.json({ reason: 'invalid-path' }, { status: 400 });
        const read = await env.readTextFile(path, context);
        return read.ok ? Response.json({ path, text: read.value }) : Response.json({ reason: 'not-found' }, { status: 404 });
      }
      default: return undefined;
    }
  };
}
