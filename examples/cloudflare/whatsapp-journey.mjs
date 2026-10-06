// WhatsApp journey against the Cloudflare recipe run locally by `wrangler dev`: signed Meta webhooks in, a local stand-in for the
// Graph API out, a real model. It never contacts Meta. Fictional sender numbers only. Includes self-evolution: a reload approved by a
// tapped button, the person's "/reload", and the approved tool after a restart.
//
//   node examples/cloudflare/whatsapp-journey.mjs
//
// Model: Workers AI by default (no model secret; needs CLOUDFLARE_API_TOKEN for the AI binding). A ChatGPT sign-in only with
// JOURNEY_CHATGPT_CREDENTIAL=<path> to a credential of its own (`node examples/cloudflare/scripts/chatgpt-login.mjs <path>`), never the
// deployment's seed: a local refresh rotates the refresh token of the file it came from. JOURNEY_MODEL=openai uses OPENAI_API_KEY.
// State: wrangler persists into a fresh temporary directory (`--persist-to`) that this run deletes; the default .wrangler/state is
// never touched. Writes .cache/evidence/whatsapp-journey.json.
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tamperedSignature } from './src/view-links.mjs';

const OWNER = '15550001', STRANGER = '15559999', PORT = Number(process.env.CF_PORT ?? 8799);
const secrets = { WHATSAPP_ACCESS_TOKEN: 'fictional-access', WHATSAPP_APP_SECRET: randomBytes(16).toString('hex'), WHATSAPP_VERIFY_TOKEN: 'fictional-verify',
  WHATSAPP_PHONE_NUMBER_ID: '1000', WHATSAPP_ALLOWED: OWNER, ACCESS_TOKEN: randomBytes(16).toString('hex'), ENABLE_DEBUG_ROUTES: '1' };
// The ChatGPT credential a deployed Worker is seeded with (chatgpt-login.mjs's default output). The journey never reads it.
const DEPLOYMENT_SEED = '.cache/chatgpt-credential.json';
const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
let model;
if (process.env.JOURNEY_CHATGPT_CREDENTIAL) {
  const path = process.env.JOURNEY_CHATGPT_CREDENTIAL;
  if (same(path, DEPLOYMENT_SEED)) throw new Error(`${path} is the deployment's seed; sign in separately: node examples/cloudflare/scripts/chatgpt-login.mjs .cache/journey-chatgpt-credential.json`);
  secrets.CHATGPT_CREDENTIAL = readFileSync(path, 'utf8').trim();
  model = 'chatgpt';
} else if (process.env.JOURNEY_MODEL === 'openai') {
  if (!process.env.OPENAI_API_KEY) throw new Error('JOURNEY_MODEL=openai needs OPENAI_API_KEY');
  secrets.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  model = 'openai';
} else {
  // No model secret: the recipe uses its Workers AI binding, which wrangler dev reaches with the account's API token.
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('Workers AI (the default model) needs CLOUDFLARE_API_TOKEN; or set JOURNEY_CHATGPT_CREDENTIAL=<separate sign-in>');
  model = 'workers-ai';
}

// The Graph API stand-in: records every message the agent sends.
const sent = [];
const graph = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => { sent.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(body || '{}') }); response.setHeader('content-type', 'application/json'); response.end('{"messages":[{"id":"wamid.out"}]}'); });
});
await new Promise(resolve => graph.listen(0, '127.0.0.1', resolve));
const graphOrigin = `http://127.0.0.1:${graph.address().port}`;

// The default local state wrangler would use. This run never writes or deletes it; a fingerprint before and after proves it.
const DEFAULT_STATES = ['.wrangler/state', 'examples/cloudflare/.wrangler/state'];
const fingerprint = () => DEFAULT_STATES.map(root => {
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => { const path = join(dir, entry.name); return entry.isDirectory() ? walk(path) : [`${path}:${statSync(path).size}:${statSync(path).mtimeMs}`]; });
  return existsSync(root) ? walk(root).sort().join('\n') : `${root}: absent`;
}).join('\n');
const defaultStateBefore = fingerprint();
// Everything this run owns lives in one fresh temporary directory: the secrets file (`--env-file`, 0600) and wrangler's persisted
// state (`--persist-to`). The finally block deletes that directory and nothing else.
const own = mkdtempSync(join(tmpdir(), 'whatsapp-journey-'));
const persist = join(own, 'state'), varsFile = join(own, 'journey.env');
writeFileSync(varsFile, Object.entries({ ...secrets, WHATSAPP_GRAPH_ORIGIN: graphOrigin }).map(([key, value]) => { if (String(value).includes("'")) throw new Error(`${key} contains a single quote`); return `${key}='${value}'`; }).join('\n'), { mode: 0o600 });
// Its own process group (detached), so a failing run still stops wrangler and workerd: the finally block signals the whole group.
const wrangler = spawn('npx', ['wrangler', 'dev', '--config', 'examples/cloudflare/wrangler.jsonc', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--env-file', varsFile],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = '';
wrangler.stdout.on('data', chunk => { log += chunk; }); wrangler.stderr.on('data', chunk => { log += chunk; });
const exited = new Promise(resolve => wrangler.once('exit', resolve));
const groupAlive = () => { try { process.kill(-wrangler.pid, 0); return true; } catch { return false; } };
async function stopWrangler() {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-wrangler.pid, signal); } catch { /* already gone */ }
    const end = Date.now() + 10_000;
    while (groupAlive() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 200));
    if (!groupAlive()) break;
  }
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
}
const base = `http://127.0.0.1:${PORT}`;
// Every request to the Worker goes through here and is counted, so the restart proof can show it made none while recovering.
let objectRequests = 0;
const toWorker = (path, init) => { objectRequests++; return fetch(`${base}${path}`, init); };
const steps = [];
const step = (name, ok, detail) => { steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); };
const until = async (label, check, ms = 120_000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error(`timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 250)); } };
const envelope = (id, text, from = OWNER) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1000' }, messages: [{ id, from, type: 'text', text: { body: text } }] } }] }] });
const sign = body => `sha256=${createHmac('sha256', secrets.WHATSAPP_APP_SECRET).update(body).digest('hex')}`;
const post = async (id, text, from) => { const body = envelope(id, text, from); const response = await toWorker('/whatsapp', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } }); return { status: response.status, body: await response.json().catch(() => null) }; };
const api = (path, init = {}) => toWorker(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${secrets.ACCESS_TOKEN}` } });
const texts = () => sent.filter(item => item.body.type === 'text').map(item => item.body.text.body);

try {
  console.log(`model: ${model}; wrangler state: ${persist}`);
  await until('wrangler dev ready', async () => { try { return (await toWorker('/api/agent')).status === 401; } catch { return false; } }, 90_000);
  const challenge = await toWorker(`/whatsapp?hub.mode=subscribe&hub.verify_token=fictional-verify&hub.challenge=4242`);
  step('Meta subscription challenge answered', challenge.status === 200 && await challenge.text() === '4242');
  const wrongToken = await toWorker(`/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
  step('a wrong verify token is refused', wrongToken.status === 403);
  const unsigned = await toWorker('/whatsapp', { method: 'POST', body: envelope('wamid.x', 'hi'), headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` } });
  step('a bad signature is refused', unsigned.status === 401);
  const stranger = await post('wamid.s', 'Hello?', STRANGER);
  step('an unknown sender is acknowledged but not answered', stranger.status === 200 && stranger.body?.accepted === 0);

  const first = await post('wamid.1', 'Reply with exactly the words: fictional pong');
  step('the owner message is admitted', first.status === 200 && first.body?.accepted === 1, first.body);
  await until('typing indicator', () => sent.some(item => item.body.status === 'read'));
  step('read mark and typing indicator sent', true);
  await until('reply', () => texts().length >= 1);
  step('the agent answer reaches WhatsApp', /fictional pong/i.test(texts()[0]), texts()[0]);
  step('Graph calls carry the access token and the business number', sent.every(item => item.auth === 'Bearer fictional-access' && item.path.endsWith('/1000/messages')));
  const again = await post('wamid.1', 'Reply with exactly the words: fictional pong');
  await new Promise(resolve => setTimeout(resolve, 3000));
  step('a redelivered webhook is not answered twice', again.body?.accepted === 0 && texts().length === 1);
  step('the stranger never got a message', sent.every(item => item.body.to === undefined || item.body.to === OWNER));

  // Memory: a fact from one message is used in a later one, and the WhatsApp conversation runs with OptChat.
  await post('wamid.m1', 'Remember this fictional code word for later: BLUE-HERON. Reply only with OK.');
  await until('memory ack', () => texts().length >= 2);
  await post('wamid.m2', 'What was the fictional code word I gave you? Reply with the word only.');
  await until('memory answer', () => texts().length >= 3);
  step('a fact from an earlier message is remembered', /BLUE-HERON/i.test(texts()[2]), texts()[2]);
  const conversations = await (await api('/api/conversations')).json();
  const whatsappId = conversations.conversations?.find(item => /fictional pong/.test(item.title ?? ''))?.id;
  const memory = await (await api(`/api/memory?conversation=${whatsappId}`)).json();
  step('OptChat memory is selected and shaped the last request', memory.selected === true && memory.stats?.leaves > 0 && memory.stats?.lastRequest !== undefined, { leaves: memory.stats?.leaves, summaries: memory.stats?.summaries, lastRequest: memory.stats?.lastRequest?.settled });
  step('the WhatsApp conversation is in the web chat history', conversations.conversations?.some(item => /fictional pong/.test(item.title ?? '')), conversations.conversations?.map(item => item.title));

  // Its own filesystem: the agent writes a file with bash and commits it with git; both survive an object reset.
  const before0 = texts().length;
  await post('wamid.f1', 'In your workspace, use bash to create the file notes/todo.md containing exactly: buy fictional milk. Then commit it with git with the message "add todo". Reply only with DONE.');
  await until('file reply', () => texts().length > before0, 240_000);
  const instance0 = (await (await api('/api/agent')).json()).instance;
  await api('/api/debug/restart', { method: 'POST' }).catch(() => undefined);
  await until('object restarted (files)', async () => { try { return (await (await api('/api/agent')).json()).instance !== instance0; } catch { return false; } });
  const file = await (await api('/api/file?path=notes/todo.md')).json();
  step('a file the agent wrote survives a restart', /buy fictional milk/.test(file.text ?? ''), file);
  const listing = await (await api('/api/files')).json();
  step('its git repository survives too', listing.files?.some(item => item.path.startsWith('.git/')), listing.files?.length);

  // Self-evolution with approval: the agent writes its own tool and instructions into .agent/, its reload asks the person as WhatsApp
  // buttons with what changes, and nothing takes effect before Approve is tapped. The person's "/reload" applies at once without a
  // model turn. The approved state survives a restart.
  const questions = () => sent.filter(item => item.body.type === 'interactive');
  const tap = async (id, button) => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1000' },
      messages: [{ id, from: OWNER, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: button.reply.id, title: button.reply.title } } }] } }] }] });
    return toWorker('/whatsapp', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } });
  };
  const questionsBefore = questions().length, beforeEvolve = texts().length;
  await post('wamid.e1', 'Give yourself a word_count tool: write .agent/tools/word-count.sh (it reads the JSON arguments on standard input, takes the "text" field and prints only its number of words; use sed and wc, there is no jq or node) and .agent/tools/word-count.json describing it (parameters: an object with a required string "text"; run: sh .agent/tools/word-count.sh). Also write .agent/AGENTS.md with one line: End every answer with "-- Tidewater desk". Then call reload.');
  await until('reload approval question', () => questions().length > questionsBefore, 240_000);
  const question = questions().at(-1).body.interactive;
  step('reload asks the person as WhatsApp buttons, with what changes', /^Allow reload\? Instructions: \d+ line\(s\) added/.test(question.body.text) && /Tools: added word_count/.test(question.body.text)
    && question.action.buttons.map(button => button.reply.title).join(',') === 'Approve,Deny', question.body.text);
  step('nothing is applied while the person decides', texts().length === beforeEvolve);
  const approve = question.action.buttons.find(button => button.reply.title === 'Approve');
  await tap('wamid.e1-approve', approve);
  await until('reload reply', () => texts().length > beforeEvolve, 240_000);
  // The model words its reply freely; that the reload applied is proven by the next step (the tool and instructions in use).
  step('after Approve the agent answers about the reload', /word_count|reload/i.test(texts().slice(beforeEvolve).join('\n')) && !/denied/i.test(texts().slice(beforeEvolve).join('\n')), texts().slice(beforeEvolve).join('\n').slice(0, 300));
  const beforeUse = texts().length;
  await post('wamid.e2', 'Use your word_count tool on: the quick brown fox jumps over the lazy dog. Reply with the number it printed.');
  await until('word_count reply', () => texts().length > beforeUse, 240_000);
  step('the next turn uses the approved tool and instructions', /\b9\b/.test(texts()[beforeUse]) && /Tidewater desk/i.test(texts()[beforeUse]), texts()[beforeUse]);
  const beforeCommand = texts().length;
  await post('wamid.e3', '/reload');
  await until('/reload reply', () => texts().length > beforeCommand, 60_000);
  const command = (await (await api(`/api/chat?op=submission&conversation=${whatsappId}&requestId=${encodeURIComponent('channel:whatsapp:wamid.e3')}`)).json()).record;
  step('"/reload" answers with the reload report and starts no model turn', /^Reloaded \.agent\/ \(self-evolving:workspace\)\./.test(texts()[beforeCommand]) && /Now: word_count/.test(texts()[beforeCommand]) && command == null,
    { reply: texts()[beforeCommand].slice(0, 200), submission: command ?? null });
  const instanceE = (await (await api('/api/agent')).json()).instance;
  await api('/api/debug/restart', { method: 'POST' }).catch(() => undefined);
  await until('object restarted (self-evolution)', async () => { try { return (await (await api('/api/agent')).json()).instance !== instanceE; } catch { return false; } });
  const beforeRestartUse = texts().length;
  await post('wamid.e4', 'Use your word_count tool on: tide tables never sleep. Reply with the number it printed.');
  await until('word_count after restart', () => texts().length > beforeRestartUse, 240_000);
  step('the approved tool survives a restart', /\b4\b/.test(texts()[beforeRestartUse]), texts()[beforeRestartUse]);

  // View links: the agent makes a read-only link to a file it wrote; it opens without the bearer token, sandboxed.
  const beforeLink = texts().length;
  await post('wamid.l1', 'Write the file notes/plan.md containing a Markdown heading "Fictional plan" and one bullet "pack fictional bags". Then call share_link for that file and reply with only the link.');
  await until('link reply', () => texts().length > beforeLink, 240_000);
  const link = texts()[beforeLink].match(/https?:\/\/\S+\/v\/[A-Za-z0-9_.-]+/)?.[0];
  step('the agent replies with a view link', Boolean(link), texts()[beforeLink]);
  if (link) {
    // `?raw=1` is the sandboxed read-only preview; the bare link opens the editable workspace app (see links-journey.mjs).
    const viewed = await fetch(`${link.replace(/^https?:\/\/[^/]+/, base)}?raw=1`);
    const html = await viewed.text();
    step('the link opens without the bearer token and shows the file', viewed.status === 200 && /Fictional plan/.test(html) && /pack fictional bags/.test(html));
    step('the page is sandboxed', /sandbox/.test(viewed.headers.get('content-security-policy') ?? ''));
    const tampered = await fetch(`${tamperedSignature(link.replace(/^https?:\/\/[^/]+/, base))}?raw=1`);
    step('a tampered link is refused', tampered.status === 404);
  }

  // Restart proofs, one per boundary, each made deterministic by a debug-only hold (src/debug-holds.mjs) instead of timing:
  //   generation  the model stream of the message waits before it starts: the answer does not exist yet when the object resets
  //   delivery    the answer has settled and the gateway waits before the Graph send: the reply is owed, not sent, at the reset
  // After the reset the journey makes no request to the Worker at all and polls only the Graph stand-in. The reply can only arrive
  // if the object restarts on its own (its wake alarm), resumes the native run or the owed delivery, and sends. Holds live in
  // memory, so the restarted object runs through both boundaries. Each case expects exactly one reply: the reset always happens
  // before the send, so at-least-once delivery has nothing to repeat.
  const holdsState = async () => (await api('/api/debug/holds')).json();
  async function restartAt(boundary, messageId, text) {
    const requestId = `channel:whatsapp:${messageId}`;
    const submission = async () => (await (await api(`/api/chat?op=submission&conversation=${whatsappId}&requestId=${encodeURIComponent(requestId)}`)).json()).record;
    const match = boundary === 'generation' ? text : requestId;
    const armed = await api('/api/debug/holds', { method: 'POST', body: JSON.stringify({ boundary, match }), headers: { 'content-type': 'application/json' } });
    step(`[${boundary}] the hold is armed`, armed.status === 200);
    const before = (await (await api('/api/agent')).json()).instance;
    const textsBefore = texts().length;
    await post(messageId, text);
    await until(`[${boundary}] the hold is reached`, async () => (await holdsState()).waiting.some(hold => hold.boundary === boundary && hold.match === match));
    const record = await submission();
    const expected = boundary === 'generation' ? 'placed' : 'done';
    step(`[${boundary}] held: the submission is ${expected} and nothing reached WhatsApp`, record?.status === expected && texts().length === textsBefore, { status: record?.status, id: record?.id });
    await api('/api/debug/restart', { method: 'POST' }).catch(() => undefined);
    const requestsAtReset = objectRequests;
    step(`[${boundary}] the reply had not reached WhatsApp when the reset returned`, texts().length === textsBefore);
    // Only the local Graph stand-in is polled from here on.
    await until(`[${boundary}] reply after restart`, () => texts().length > textsBefore, 300_000);
    step(`[${boundary}] no request reached the Worker between the reset and the reply`, objectRequests === requestsAtReset, { requests: objectRequests - requestsAtReset });
    await new Promise(resolve => setTimeout(resolve, 10_000));
    const after = texts().slice(textsBefore);
    step(`[${boundary}] exactly one reply for that message, delivered after the restart`, after.length === 1 && /fictional (one|two)/i.test(after[0]), after.map(item => item.slice(0, 60)));
    const instance = (await (await api('/api/agent')).json()).instance;
    const final = await submission();
    step(`[${boundary}] the object restarted; the same native submission (id before = id after) is done`, instance !== before && final?.status === 'done' && record?.id !== undefined && final.id === record.id,
      { restarted: instance !== before, status: final?.status, before: record?.id, after: final?.id });
    step(`[${boundary}] the restarted object has no hold left`, JSON.stringify(await holdsState()) === JSON.stringify({ armed: [], waiting: [] }));
  }
  await restartAt('generation', 'wamid.2', 'Reply with exactly the words: fictional one');
  await restartAt('delivery', 'wamid.3', 'Reply with exactly the words: fictional two');
  step('wrangler persisted into the temporary directory only', existsSync(persist) && readdirSync(persist).length > 0, readdirSync(persist));
} catch (error) {
  step('journey', false, String(error?.message ?? error));
} finally {
  await stopWrangler(); graph.close();
  step('wrangler dev and its children stopped', !groupAlive());
  rmSync(own, { recursive: true, force: true });
  step('the temporary state is deleted and the default .wrangler/state untouched', !existsSync(own) && fingerprint() === defaultStateBefore);
  mkdirSync('.cache/evidence', { recursive: true });
  writeFileSync('.cache/evidence/whatsapp-journey.json', JSON.stringify({ at: new Date().toISOString(), model, steps, sent: sent.map(item => ({ path: item.path, type: item.body.type ?? item.body.status, to: item.body.to })) }, null, 2));
  if (steps.some(item => !item.ok)) { console.log('\nwrangler log (tail):\n' + log.split('\n').filter(line => !/CHATGPT|OPENAI|WHATSAPP_APP_SECRET|ACCESS_TOKEN/.test(line)).slice(-40).join('\n')); process.exitCode = 1; }
}
