// Shared by the Cloudflare journeys that run the recipe locally with `wrangler dev`: the model choice (never the deployment's ChatGPT
// seed) and an isolated local Worker (secrets and persisted state in one fresh temporary directory; the default .wrangler/state and
// examples/cloudflare/.dev.vars are never written or deleted, which a fingerprint before and after proves).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The ChatGPT credential a deployed Worker is seeded with (chatgpt-login.mjs's default output). A journey never reads it. */
export const DEPLOYMENT_SEED = '.cache/chatgpt-credential.json';
const sameFile = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };

/**
 * The model a journey runs with, adding its secret to `secrets`. ChatGPT only with JOURNEY_CHATGPT_CREDENTIAL=<path> to a sign-in of its
 * own: a local refresh rotates the refresh token of the file it came from, so the deployment's seed is refused. JOURNEY_MODEL=openai uses
 * OPENAI_API_KEY; the default is Workers AI through the AI binding (no model secret; wrangler dev needs CLOUDFLARE_API_TOKEN).
 */
export function journeyModel(secrets, env = process.env) {
  if (env.JOURNEY_CHATGPT_CREDENTIAL) {
    const path = env.JOURNEY_CHATGPT_CREDENTIAL;
    if (sameFile(path, DEPLOYMENT_SEED)) throw new Error(`${path} is the deployment's seed; sign in separately: node examples/cloudflare/scripts/chatgpt-login.mjs .cache/journey-chatgpt-credential.json`);
    secrets.CHATGPT_CREDENTIAL = readFileSync(path, 'utf8').trim();
    return 'chatgpt';
  }
  if (env.JOURNEY_MODEL === 'chatgpt') throw new Error('JOURNEY_MODEL=chatgpt needs JOURNEY_CHATGPT_CREDENTIAL=<path to a separate sign-in>; the deployment seed is never used');
  if (env.JOURNEY_MODEL === 'openai') {
    if (!env.OPENAI_API_KEY) throw new Error('JOURNEY_MODEL=openai needs OPENAI_API_KEY');
    secrets.OPENAI_API_KEY = env.OPENAI_API_KEY;
    return 'openai';
  }
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error('Workers AI (the default model) needs CLOUDFLARE_API_TOKEN; or set JOURNEY_CHATGPT_CREDENTIAL=<separate sign-in>');
  return 'workers-ai';
}

const DEFAULTS = ['.wrangler/state', 'examples/cloudflare/.wrangler/state', 'examples/cloudflare/.dev.vars'];
const fingerprint = () => DEFAULTS.map(root => {
  const walk = path => statSync(path).isDirectory() ? readdirSync(path).flatMap(name => walk(join(path, name))) : [`${path}:${statSync(path).size}:${statSync(path).mtimeMs}`];
  return existsSync(root) ? walk(root).sort().join('\n') : `${root}: absent`;
}).join('\n');

/**
 * Start `wrangler dev` for the recipe on 127.0.0.1:`port` with `vars` (written to a 0600 `--env-file`) and state persisted under
 * `--persist-to`, both inside one fresh temporary directory named after `name` (or the caller's `persist` directory for the state). `stop()` stops the whole process group (npx, wrangler,
 * workerd) and deletes that directory only; it returns whether the group stopped, the directory is gone and the defaults are untouched.
 */
export async function startLocalWorker({ name, port, vars, persist: kept }) {
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) throw new Error(`port ${port} is in use; set CF_PORT`);
  const defaultsBefore = fingerprint();
  const own = mkdtempSync(join(tmpdir(), `${name}-`));
  // `persist` (optional): a state directory the caller owns and deletes, so a second run continues the first one's state (a restart).
  const persist = kept ?? join(own, 'state'), varsFile = join(own, 'journey.env');
  try {
    writeFileSync(varsFile, Object.entries(vars).map(([key, value]) => { if (String(value).includes("'")) throw new Error(`${key} contains a single quote`); return `${key}='${value}'`; }).join('\n'), { mode: 0o600 });
  } catch (error) { rmSync(own, { recursive: true, force: true }); throw error; }
  // Its own process group (detached), so a failing run still stops wrangler and workerd.
  const wrangler = spawn('npx', ['wrangler', 'dev', '--config', 'examples/cloudflare/wrangler.jsonc', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--env-file', varsFile],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  wrangler.stdout.on('data', chunk => { log += chunk; }); wrangler.stderr.on('data', chunk => { log += chunk; });
  const exited = new Promise(resolve => { if (wrangler.exitCode !== null) resolve(); else wrangler.once('exit', resolve); });
  // A crash that skips the caller's finally block still stops the group and deletes this run's directory.
  process.on('exit', () => { try { process.kill(-wrangler.pid, 'SIGKILL'); } catch { /* already gone */ } rmSync(own, { recursive: true, force: true }); });
  const alive = () => { try { process.kill(-wrangler.pid, 0); return true; } catch { return false; } };
  return {
    base: `http://127.0.0.1:${port}`,
    persist,
    log: () => log,
    async stop() {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        try { process.kill(-wrangler.pid, signal); } catch { /* already gone */ }
        const end = Date.now() + 10_000;
        while (alive() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 200));
        if (!alive()) break;
      }
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
      rmSync(own, { recursive: true, force: true });
      return { stopped: !alive(), deleted: !existsSync(own), defaultsUntouched: fingerprint() === defaultsBefore };
    },
  };
}
