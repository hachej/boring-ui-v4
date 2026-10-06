// Links journey against the Cloudflare recipe run locally by `wrangler dev`: the agent sends a link on WhatsApp (fictional sender,
// local stand-in for the Graph API, never Meta) and a real Chromium opens it with no stored token. The link opens the web workspace on
// that WhatsApp conversation with the linked file in its editor; a save reaches the agent's workspace, a change the agent makes behind
// the editor is a conflict, expired or tampered links are refused, a session token (and a chat watch opened with it) stops working when
// it expires, a reload with an expired session recovers from the kept link, and a phone shows
// the document first with a button to the chat.
//
//   CLOUDFLARE_API_TOKEN=... CHROMIUM=<chromium or chrome-headless-shell> node examples/cloudflare/links-journey.mjs
//
// Model: Workers AI through the AI binding by default (no model secret is written). A ChatGPT sign-in only with
// JOURNEY_CHATGPT_CREDENTIAL=<path> to a credential of its own, never the deployment's seed (.cache/chatgpt-credential.json): a local
// refresh rotates the refresh token of the file it came from. JOURNEY_MODEL=openai uses OPENAI_API_KEY. The session lifetime is
// shortened to SESSION_TTL_SECONDS (default 60) so expiry and renewal happen during the run.
// State: wrangler persists into a fresh temporary directory (`--persist-to`) with the secrets file (`--env-file`, 0600) beside it; the
// run deletes that directory and never touches the default .wrangler/state or examples/cloudflare/.dev.vars.
// Evidence: .cache/evidence/cloudflare-links/ (journey.json and screenshots).
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../studio/driver.mjs';
import { signViewLink, tamperedSignature } from './src/view-links.mjs';

const OWNER = '15550001', PORT = Number(process.env.CF_PORT ?? 8798), TTL = Number(process.env.SESSION_TTL_SECONDS ?? 60);
const evidence = '.cache/evidence/cloudflare-links';
mkdirSync(evidence, { recursive: true });
const secrets = { WHATSAPP_ACCESS_TOKEN: 'fictional-access', WHATSAPP_APP_SECRET: randomBytes(16).toString('hex'), WHATSAPP_VERIFY_TOKEN: 'fictional-verify',
  WHATSAPP_PHONE_NUMBER_ID: '1000', WHATSAPP_ALLOWED: OWNER, ACCESS_TOKEN: randomBytes(16).toString('hex'), SESSION_TTL_SECONDS: String(TTL) };
// The ChatGPT credential a deployed Worker is seeded with (chatgpt-login.mjs's default output). The journey never reads it.
const DEPLOYMENT_SEED = '.cache/chatgpt-credential.json';
const sameFile = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
let model;
if (process.env.JOURNEY_CHATGPT_CREDENTIAL) {
  const path = process.env.JOURNEY_CHATGPT_CREDENTIAL;
  if (sameFile(path, DEPLOYMENT_SEED)) throw new Error(`${path} is the deployment's seed; sign in separately: node examples/cloudflare/scripts/chatgpt-login.mjs .cache/journey-chatgpt-credential.json`);
  secrets.CHATGPT_CREDENTIAL = readFileSync(path, 'utf8').trim();
  model = 'chatgpt';
} else if (process.env.JOURNEY_MODEL === 'chatgpt') {
  throw new Error('JOURNEY_MODEL=chatgpt needs JOURNEY_CHATGPT_CREDENTIAL=<path to a separate sign-in>; the deployment seed is never used');
} else if (process.env.JOURNEY_MODEL === 'openai') {
  if (!process.env.OPENAI_API_KEY) throw new Error('JOURNEY_MODEL=openai needs OPENAI_API_KEY');
  secrets.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  model = 'openai';
} else {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('Workers AI (the default model) needs CLOUDFLARE_API_TOKEN; or set JOURNEY_CHATGPT_CREDENTIAL=<separate sign-in>');
  model = 'workers-ai';
}
if (!process.env.CHROMIUM || !existsSync(process.env.CHROMIUM)) throw new Error('Set CHROMIUM to a Chromium or chrome-headless-shell binary');

const sent = [];
const graph = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => { sent.push({ path: request.url, body: JSON.parse(body || '{}') }); response.setHeader('content-type', 'application/json'); response.end('{"messages":[{"id":"wamid.out"}]}'); });
});
await new Promise(resolve => graph.listen(0, '127.0.0.1', resolve));
// A server already on the port would answer the readiness check in place of this run's.
if (await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false)) throw new Error(`port ${PORT} is in use; set CF_PORT`);

// The default local state and secrets wrangler would use. This run never writes or deletes them; a fingerprint before and after proves it.
const DEFAULTS = ['.wrangler/state', 'examples/cloudflare/.wrangler/state', 'examples/cloudflare/.dev.vars'];
const fingerprint = () => DEFAULTS.map(root => {
  const walk = path => statSync(path).isDirectory() ? readdirSync(path).flatMap(name => walk(join(path, name))) : [`${path}:${statSync(path).size}:${statSync(path).mtimeMs}`];
  return existsSync(root) ? walk(root).sort().join('\n') : `${root}: absent`;
}).join('\n');
const defaultsBefore = fingerprint();
// Everything this run owns lives in one fresh temporary directory: the secrets file and wrangler's persisted state.
const own = mkdtempSync(join(tmpdir(), 'links-journey-'));
const persist = join(own, 'state'), varsFile = join(own, 'journey.env');
writeFileSync(varsFile, Object.entries({ ...secrets, WHATSAPP_GRAPH_ORIGIN: `http://127.0.0.1:${graph.address().port}` }).map(([key, value]) => { if (String(value).includes("'")) throw new Error(`${key} contains a single quote`); return `${key}='${value}'`; }).join('\n'), { mode: 0o600 });
// Its own process group (detached), so a failing run still stops wrangler and workerd: the finally block signals the whole group.
const wrangler = spawn('npx', ['wrangler', 'dev', '--config', 'examples/cloudflare/wrangler.jsonc', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--env-file', varsFile],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
const exited = new Promise(resolve => { if (wrangler.exitCode !== null) resolve(); else wrangler.once('exit', resolve); });
// A crash that skips the finally block (an unhandled error event) still stops the group and deletes this run's directory.
process.on('exit', () => { try { process.kill(-wrangler.pid, 'SIGKILL'); } catch { /* already gone */ } rmSync(own, { recursive: true, force: true }); });
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
let log = '';
wrangler.stdout.on('data', chunk => { log += chunk; }); wrangler.stderr.on('data', chunk => { log += chunk; });
const base = `http://127.0.0.1:${PORT}`;

const steps = [];
// Link tokens are credentials: evidence and output show `/v/<link>` instead.
const redact = text => String(text).replace(/\/v\/[A-Za-z0-9_.-]+/g, '/v/<link>');
const step = (name, ok, detail) => { detail = detail === undefined ? undefined : JSON.parse(redact(JSON.stringify(detail))); steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (label, check, ms = 120_000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error(`timeout: ${label}`); await pause(250); } };
const envelope = (id, text) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1000' }, messages: [{ id, from: OWNER, type: 'text', text: { body: text } }] } }] }] });
const post = async (id, text) => { const body = envelope(id, text); return fetch(`${base}/whatsapp`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secrets.WHATSAPP_APP_SECRET).update(body).digest('hex')}` } }); };
const texts = () => sent.filter(item => item.body.type === 'text').map(item => item.body.text.body);
/** Sends one WhatsApp message and waits for the agent's next reply. */
const ask = async (id, text, ms = 240_000) => { const before = texts().length; await post(id, text); await until(`reply to ${id}`, () => texts().length > before, ms); return texts()[before]; };
const bearer = token => ({ authorization: `Bearer ${token}` });
const owner = path => fetch(`${base}${path}`, { headers: bearer(secrets.ACCESS_TOKEN) });
const fileText = async path => (await (await owner(`/api/file?path=${encodeURIComponent(path)}`)).json()).text ?? '';
const local = url => url.replace(/^https?:\/\/[^/]+/, base);
const payloadOf = link => JSON.parse(Buffer.from(link.split('/v/')[1].split('.')[0], 'base64url').toString('utf8'));
const exchange = link => fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link }) });
const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
const PANEL = '[data-testid=workspace-panel]';
const status = q(`${PANEL} [data-testid=viewer-status]`), source = q(`${PANEL} textarea`);

let browser;
try {
  await until('wrangler dev ready', async () => { try { return (await fetch(`${base}/api/agent`)).status === 401; } catch { return false; } }, 90_000);
  console.log(`model: ${model}; wrangler state: ${persist}`);

  // 1. The agent writes a file and sends a link to it on WhatsApp.
  const reply = await ask('wamid.l1', 'In your workspace, write the file notes/plan.md containing a Markdown heading "Fictional plan" and one bullet "pack fictional bags". Then call share_link for that file and reply with only the link.');
  const link = reply?.match(/https?:\/\/\S+?\/v\/[A-Za-z0-9_.-]+/)?.[0];
  step('the agent replies on WhatsApp with a link', Boolean(link), reply);
  if (!link) throw new Error('no link');
  const linkToken = link.split('/v/')[1];
  const conversations = (await (await owner('/api/conversations')).json()).conversations;
  const whatsappId = conversations.find(item => /notes\/plan\.md/.test(item.title ?? ''))?.id;
  const payload = payloadOf(link);
  step('the link names the WhatsApp conversation and the file', payload.kind === 'file' && payload.path === 'notes/plan.md' && Number(payload.conversation) === whatsappId, { payload: { ...payload, exp: undefined }, whatsappId });

  const page = await fetch(local(link));
  step('the link serves the app page (no data in it, not cached, no referrer)', page.status === 200 && /<div id="root">/.test(await page.text()) && /no-store/.test(page.headers.get('cache-control') ?? '') && page.headers.get('referrer-policy') === 'no-referrer');
  const raw = await fetch(`${local(link)}?raw=1`);
  const rawHtml = await raw.text();
  step('`?raw=1` keeps the sandboxed read-only preview', raw.status === 200 && /sandbox/.test(raw.headers.get('content-security-policy') ?? '') && /pack fictional bags/.test(rawHtml));
  step('the API refuses requests without a bearer', (await fetch(`${base}/api/files`)).status === 401);

  // 2. A real browser with an empty profile opens the link: no token is stored anywhere.
  // The read-only preview first (it stores nothing): the page at the link's URL runs nothing, and the item shows only in a sandboxed
  // srcdoc frame that cannot see that URL (no referrer, its own address is about:srcdoc) nor reach the page.
  browser = await launch(`${local(link)}?raw=1`, { evidence });
  await browser.until('the preview frame', `!!${q('iframe[data-testid=view-frame]')}`, 20_000);
  const top = await browser.evaluate(`({ scripts: document.scripts.length, frames: document.querySelectorAll('iframe').length, sandbox: ${q('iframe')}.getAttribute('sandbox') })`);
  const inside = await browser.frameEvaluate(q('iframe'), `({ href: location.href, referrer: document.referrer, text: document.body.innerText })`);
  step('`?raw=1` runs nothing at the link URL; the file shows in a sandboxed srcdoc frame that cannot see the link', top.scripts === 0 && top.frames === 1 && top.sandbox === ''
    && inside.href === 'about:srcdoc' && inside.referrer === '' && /pack fictional bags/.test(inside.text), { top, inside: { href: inside.href, referrer: inside.referrer } });
  await browser.send('Page.navigate', { url: local(link) });
  await browser.until('the chat is live on the linked conversation', `${q('[data-testid=connection]')}?.dataset.state === 'connected' && !!${q('[data-testid=composer-input]')}`, 60_000);
  const shown = await browser.evaluate(`({ conversation: ${q('[data-testid=studio-main]')}?.dataset.conversation, gate: !!${q('[data-testid=token-form]')}, address: location.pathname + location.search + location.hash })`);
  step('the link opened without a stored token, on the WhatsApp conversation, and left the address bar', Number(shown.conversation) === whatsappId && !shown.gate && shown.address === '/', shown);
  await browser.until('the transcript shows the WhatsApp messages', `${q('[data-testid=transcript]')}?.innerText.includes('notes/plan.md')`, 30_000);
  step('the chat pane shows the conversation from WhatsApp', true);
  await browser.until('the linked file is open in its editor', `${q('[data-testid=file-viewer][data-path="/workspace/notes/plan.md"]')} && !${status}`, 30_000);
  const layout = await browser.evaluate(`(() => { const chat = ${q('[data-testid=workspace-chat]')}.getBoundingClientRect(), panel = ${q(PANEL)}.getBoundingClientRect(); return { chat: Math.round(chat.width), panel: Math.round(panel.width), side: chat.right <= panel.left + 8, sheet: ${q(PANEL)}.dataset.sheet }; })()`);
  step('desktop: chat and the file side by side', layout.side && layout.chat > 300 && layout.panel > 300 && layout.sheet === 'false', layout);
  await browser.screenshot('01-desktop-link-opened.png');
  const firstSession = await browser.evaluate(`sessionStorage.getItem('recipe.token')`);

  // 3. Edit and save: the workspace file changes.
  await browser.click(q(`${PANEL} [data-testid=viewer-mode-source]`));
  await browser.until('source editor', `!!${source}`);
  await browser.type(source, '\nPERSON-EDIT fictional line\n');
  await browser.until('unsaved', `${status}?.textContent === 'Unsaved'`);
  await browser.click(q(`${PANEL} [data-testid=viewer-save]`));
  await browser.until('saved', `!${status}`, 30_000);
  const saved = await fileText('notes/plan.md');
  step('saving writes the workspace file (read back through /api/file)', saved.includes('PERSON-EDIT fictional line') && saved.includes('pack fictional bags'), saved);
  await browser.screenshot('02-desktop-saved.png');

  // 4. The agent sees the person's change, and its WhatsApp reply appears live in the open chat.
  const seen = await ask('wamid.l2', 'Read notes/plan.md in your workspace again now and reply with only the line of it that contains PERSON-EDIT.');
  step('the agent sees the saved change in its workspace', /PERSON-EDIT/.test(seen ?? ''), seen);
  await browser.until('the reply shows in the browser chat', `${q('[data-testid=transcript]')}?.innerText.includes('PERSON-EDIT')`, 30_000).then(() => step('the WhatsApp exchange appears live in the browser chat', true), error => step('the WhatsApp exchange appears live in the browser chat', false, String(error.message).slice(0, 200)));

  // 5. A change the agent makes while the person has unsaved edits: Save is a conflict, nothing is overwritten.
  await browser.type(source, 'LOCAL-UNSAVED fictional line\n');
  await browser.until('unsaved again', `${status}?.textContent === 'Unsaved'`);
  const agentEdit = await ask('wamid.l3', 'Use bash to append the line "AGENT-EDIT fictional line" to the end of notes/plan.md in your workspace. Do not change anything else. Reply only DONE.');
  const afterAgent = await fileText('notes/plan.md');
  step('the agent changed the file behind the editor', afterAgent.includes('AGENT-EDIT fictional line'), { reply: agentEdit });
  await browser.click(q(`${PANEL} [data-testid=viewer-save]`));
  await browser.until('conflict shown', `${q(PANEL)}?.innerText.includes('Your local text has been kept.')`, 30_000);
  const afterConflict = await fileText('notes/plan.md');
  const draft = await browser.evaluate(`${source}.value`);
  step('saving over the agent\'s change is a conflict, not an overwrite', afterConflict === afterAgent && !afterConflict.includes('LOCAL-UNSAVED') && draft.includes('LOCAL-UNSAVED'), { file: afterConflict });
  await browser.screenshot('03-desktop-conflict.png');

  // 6. Tampered and expired links are refused, in the API and in the page.
  const tampered = tamperedSignature(linkToken);
  const expired = await signViewLink(secrets.ACCESS_TOKEN, { kind: 'file', path: 'notes/plan.md', conversation: String(whatsappId) }, -60);
  const forged = await signViewLink('not-the-secret', { kind: 'file', path: 'notes/plan.md', conversation: String(whatsappId) });
  const refusals = { tamperedSession: (await exchange(tampered)).status, expiredSession: (await exchange(expired)).status, forgedSession: (await exchange(forged)).status,
    tamperedPage: (await fetch(`${base}/v/${tampered}`)).status, expiredPage: (await fetch(`${base}/v/${expired}`)).status, linkAsBearer: (await fetch(`${base}/api/files`, { headers: bearer(linkToken) })).status };
  step('tampered, expired and forged links are refused; a link is not a bearer', Object.values(refusals).every(code => code === 401 || code === 404), refusals);
  const tab = await browser.openTab(`${base}/v/${expired}`);
  await tab.until('the expired link page', `document.body.innerText.includes('expired')`, 20_000).then(() => step('the browser shows "expired or not valid" for an expired link', true), error => step('the browser shows "expired or not valid" for an expired link', false, String(error.message).slice(0, 200)));
  await tab.close();

  // 7. Sessions: owner scope only for /api/*, no debug routes, unusable after expiry; the page renews from its link.
  const fresh = await (await exchange(linkToken)).json();
  // A chat watch opened with that session must end when the session expires, not keep streaming.
  const watchOpened = Date.now();
  const watchEnd = fetch(`${base}/api/chat?conversation=${whatsappId}&op=watch`, { headers: bearer(fresh.token) }).then(async response => {
    let body = '';
    const reader = response.body.getReader();
    for (;;) { const next = await reader.read(); if (next.done) break; body += new TextDecoder().decode(next.value); }
    return { status: response.status, end: body.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(frame => frame.kind === 'end')?.reason, at: Date.now() };
  }, error => ({ error: String(error?.message ?? error) }));
  const usable = (await fetch(`${base}/api/files`, { headers: bearer(fresh.token) })).status;
  const debug = (await fetch(`${base}/api/debug/restart`, { method: 'POST', headers: bearer(fresh.token) })).status;
  step('a session token works for the API but not for the operator\'s debug routes', usable === 200 && debug === 401 && fresh.conversation === whatsappId, { usable, debug, expiresInSeconds: Math.round((fresh.expiresAt - Date.now()) / 1000) });
  await until('the first session has expired', async () => (await fetch(`${base}/api/files`, { headers: bearer(firstSession) })).status === 401, (TTL + 30) * 1000);
  step(`the browser's first session token is refused after its ${TTL} s lifetime`, true);
  await until('the fresh session has expired', async () => (await fetch(`${base}/api/files`, { headers: bearer(fresh.token) })).status === 401, (TTL + 30) * 1000);
  step('a session token from the API is refused after expiry', true);
  const watched = await Promise.race([watchEnd, pause(30_000).then(() => ({ error: 'still streaming 30 s after expiry' }))]);
  step('a chat watch opened with that session ends at its expiry', watched.status === 200 && watched.end === 'revoked' && watched.at <= fresh.expiresAt + 5000,
    { ...watched, endedAfterSeconds: watched.at ? Math.round((watched.at - watchOpened) / 1000) : undefined, at: undefined });
  const renewed = await browser.evaluate(`sessionStorage.getItem('recipe.token')`);
  const still = (await fetch(`${base}/api/files`, { headers: bearer(renewed) })).status;
  await browser.until('the page is still connected', `${q('[data-testid=connection]')}?.dataset.state === 'connected'`, 20_000);
  step('the open page renewed its session from the link and stays connected', renewed !== firstSession && still === 200, { still });

  // Reload with an expired session token stored (the link left the address bar long ago, it is kept in this tab): the page
  // exchanges the kept link before loading, never stays on Loading….
  await browser.evaluate(`(sessionStorage.setItem('recipe.token', ${JSON.stringify(firstSession)}), setTimeout(() => location.reload(), 50), true)`);
  await pause(500);
  await browser.until('reloaded page connected', `${q('[data-testid=connection]')}?.dataset.state === 'connected' && !!${q('[data-testid=studio-main]')}`, 30_000)
    .then(() => true, () => false).then(async ok => {
      const after = await browser.evaluate(`({ token: sessionStorage.getItem('recipe.token'), address: location.pathname, gate: !!${q('[data-testid=token-form]')} })`);
      step('reload after the session expired recovers from the kept link', ok && after.token !== firstSession && !after.gate && after.address === '/', { ok, gate: after.gate, address: after.address });
    });

  // 8. Phone: the link opens the document first; a button goes to the chat, and the chat's Files button comes back.
  await browser.emulate('phone');
  await browser.send('Page.navigate', { url: local(link) });
  await browser.until('phone: the file is open', `${q('[data-testid=file-viewer][data-path="/workspace/notes/plan.md"]')} && ${q(PANEL)}?.dataset.sheet === 'true' && !${status}`, 60_000);
  const phoneDoc = await browser.evaluate(`({ chatHidden: ${q('[data-testid=workspace-chat]')}.getAttribute('aria-hidden') === 'true', button: !!${q('[data-testid=open-chat]')}, width: innerWidth, scroll: document.documentElement.scrollWidth <= innerWidth })`);
  step('phone: the document comes first, full screen, with a Chat button', phoneDoc.chatHidden && phoneDoc.button && phoneDoc.scroll, phoneDoc);
  await browser.screenshot('04-phone-document.png');
  await browser.tap(q('[data-testid=open-chat]'));
  await browser.until('phone: the chat', `!${q(PANEL)} && !!${q('[data-testid=composer-input]')} && ${q('[data-testid=transcript]')}?.innerText.includes('PERSON-EDIT')`, 20_000);
  step('phone: the Chat button shows the conversation', true);
  await browser.screenshot('05-phone-chat.png');
  await browser.tap(q('[data-testid=files-open]'));
  await browser.tap(q('[data-testid=file-item][data-path="notes/plan.md"]'));
  await browser.until('phone: back to the file', `!!${q('[data-testid=file-viewer][data-path="/workspace/notes/plan.md"]')}`, 20_000);
  step('phone: Files in the chat goes back to the file', true);
  await browser.screenshot('06-phone-files-back.png');
  await browser.emulate('desktop');

  const problems = browser.problems.filter(problem => !/Failed to load resource|ERR_CONNECTION|net::|Failed to fetch|network error|401/i.test(problem));
  step('no unexpected page errors', problems.length === 0, problems.slice(0, 5));
  step('wrangler persisted into the temporary directory only', existsSync(persist) && readdirSync(persist).length > 0, readdirSync(persist));
} catch (error) {
  step('journey', false, String(error?.message ?? error).slice(0, 2000));
  if (browser) await browser.screenshot('failure.png').catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  // Stop the whole process group (npx, wrangler, workerd) and wait, so a later run never meets this server on the port.
  await stopWrangler(); graph.close();
  step('wrangler dev and its children stopped', !groupAlive());
  rmSync(own, { recursive: true, force: true });
  step('the temporary state is deleted and the default state and .dev.vars untouched', !existsSync(own) && fingerprint() === defaultsBefore);
  writeFileSync(join(evidence, 'journey.json'), JSON.stringify({ at: new Date().toISOString(), model, sessionTtlSeconds: TTL, steps, whatsapp: sent.map(item => ({ type: item.body.type ?? item.body.status, text: item.body.text?.body === undefined ? undefined : redact(item.body.text.body) })) }, null, 2));
  if (steps.some(item => !item.ok)) { console.log('\nwrangler log (tail):\n' + log.split('\n').filter(line => !/CHATGPT|OPENAI|WHATSAPP_APP_SECRET|ACCESS_TOKEN|Bearer/.test(line)).slice(-40).map(redact).join('\n')); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
