// MCP journey against the Cloudflare recipe run locally by `wrangler dev`: a fictional notes MCP server (mcp-fixture.mjs, Streamable HTTP
// on 127.0.0.1 behind an `x-api-key` check) configured through MCP_SERVERS, reached by Cloudflare's MCPClientManager inside the Durable
// Object, and used by the agent from a signed WhatsApp webhook (fictional sender, local Graph API stand-in, never Meta).
//
//   CLOUDFLARE_API_TOKEN=... node examples/cloudflare/mcp-journey.mjs
//
// Proves: the read-only tool answers; the write tool waits for approval (sent as a WhatsApp question, answered by the reply "Approve")
// and then reaches the server exactly once; Deny never reaches it; the header secret reached the server but never the transcript or a
// reply; the connection survives an object reset; a conversation that was not granted the server is not offered its tools.
// Model (scripts/local-worker.mjs): Workers AI through the AI binding by default (no model secret). A ChatGPT sign-in only with
// JOURNEY_CHATGPT_CREDENTIAL=<path> to a credential of its own, never the deployment's seed; JOURNEY_MODEL=openai uses OPENAI_API_KEY.
// State: wrangler persists into a fresh temporary directory (`--persist-to`) with the secrets file (`--env-file`, 0600) beside it; the
// run deletes that directory and never touches the default .wrangler/state or examples/cloudflare/.dev.vars.
// Evidence: .cache/evidence/cloudflare-mcp.json.
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startNotesServer } from './mcp-fixture.mjs';
import { journeyModel, startLocalWorker } from './scripts/local-worker.mjs';

const OWNER = '15550001', PORT = Number(process.env.CF_PORT ?? 8797);
const API_KEY = `fictional-notes-key-${randomBytes(12).toString('hex')}`;
const secrets = { WHATSAPP_ACCESS_TOKEN: 'fictional-access', WHATSAPP_APP_SECRET: randomBytes(16).toString('hex'), WHATSAPP_VERIFY_TOKEN: 'fictional-verify',
  WHATSAPP_PHONE_NUMBER_ID: '1000', WHATSAPP_ALLOWED: OWNER, ACCESS_TOKEN: randomBytes(16).toString('hex'), ENABLE_DEBUG_ROUTES: '1', NOTES_API_KEY: API_KEY };
const model = journeyModel(secrets);
const notes = await startNotesServer({ apiKey: API_KEY });
secrets.MCP_SERVERS = JSON.stringify([{ id: 'notes', url: notes.url, headers: { 'x-api-key': 'NOTES_API_KEY' }, allow: ['search_notes', 'create_note'], readOnly: ['search_notes'] }]);

// The Graph API stand-in: records every message the agent sends.
const sent = [];
const graph = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => { sent.push({ path: request.url, body: JSON.parse(body || '{}') }); response.setHeader('content-type', 'application/json'); response.end('{"messages":[{"id":"wamid.out"}]}'); });
});
await new Promise(resolve => graph.listen(0, '127.0.0.1', resolve));

mkdirSync('.cache/evidence', { recursive: true });
const worker = await startLocalWorker({ name: 'mcp-journey', port: PORT, vars: { ...secrets, WHATSAPP_GRAPH_ORIGIN: `http://127.0.0.1:${graph.address().port}` } });
const { base } = worker;

const steps = [];
const step = (name, ok, detail) => { steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (label, check, ms = 180_000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error(`timeout: ${label}`); await pause(250); } };
const envelope = (id, text) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1000' }, messages: [{ id, from: OWNER, type: 'text', text: { body: text } }] } }] }] });
const post = async (id, text) => { const body = envelope(id, text); const response = await fetch(`${base}/whatsapp`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secrets.WHATSAPP_APP_SECRET).update(body).digest('hex')}` } }); return response.json().catch(() => null); };
const api = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${secrets.ACCESS_TOKEN}` } });
const texts = () => sent.filter(item => item.body.type === 'text').map(item => item.body.text.body);
const questions = () => sent.filter(item => item.body.type === 'interactive').map(item => item.body.interactive.body.text);
const callsOf = (name, match = () => true) => notes.calls.filter(call => call.name === name && match(call.args));
let messageId = 0;
/** Send a WhatsApp message and wait for the agent's next text reply. */
const ask = async (text, ms = 240_000) => { const before = texts().length; await post(`wamid.${++messageId}`, text); await until(`reply to: ${text.slice(0, 40)}`, () => texts().length > before, ms); return texts().slice(before).join('\n'); };
/** Every entry of a conversation, through the chat transport's history pages (what the web chat shows). */
async function transcript(conversation) {
  const items = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const response = await (await api(`/api/chat?conversation=${conversation}&op=entries&limit=100${cursor ? `&cursor=${encodeURIComponent(JSON.stringify(cursor))}` : ''}`)).json();
    items.push(...(response.page?.items ?? []));
    if (!response.page?.next) break;
    cursor = response.page.next;
  }
  return items;
}

try {
  console.log(`model: ${model}; wrangler state: ${worker.persist}`);
  await until('wrangler dev ready', async () => { try { return (await fetch(`${base}/api/agent`)).status === 401; } catch { return false; } }, 90_000);
  const services = await (await api('/api/services?wait=1')).json();
  const server = services.servers?.find(item => item.id === 'notes');
  step('the notes server is connected through MCPClientManager', server?.state === 'ready', server);
  step('only the allowed tools are exposed', JSON.stringify(server?.tools) === JSON.stringify(['notes__search_notes', 'notes__create_note']), server?.tools);
  step('the OAuth callback route takes no bearer token and refuses a state it did not issue', (await fetch(`${base}/api/mcp/callback?state=forged.notes&code=x`)).status === 404);

  // Read: the agent searches with the read-only tool and answers with its result.
  const searched = await ask('Use the notes__search_notes tool to search my notes for "heron". Then reply with the exact title of the note it found and nothing else.');
  step('the read-only tool reaches the server and the answer uses its result', callsOf('search_notes', args => /heron/i.test(args.query)).length >= 1 && /heron sighting/i.test(searched), searched);
  const conversations = await (await api('/api/conversations')).json();
  const whatsappId = conversations.conversations?.find(item => /search_notes/.test(item.title ?? ''))?.id;
  const granted = await (await api(`/api/services?conversation=${whatsappId}`)).json();
  step('the WhatsApp conversation is granted and selects the server with OptChat', granted.granted === true && granted.selected?.includes('mcp.notes') && granted.selected?.some(name => name.includes('optchat')), granted.selected);

  // Write, approved: the call waits for the person; the reply "Approve" lets it reach the server exactly once.
  const questionsBefore = questions().length;
  await post(`wamid.${++messageId}`, 'Use the notes__create_note tool to create a note titled "Fictional picnic" with the body "bring fictional bread". Do not ask me anything first, just call the tool.');
  await until('approval question', () => questions().slice(questionsBefore).some(text => /notes__create_note/.test(text)));
  const question = questions().slice(questionsBefore).find(text => /notes__create_note/.test(text));
  step('the write waits for approval, asked on WhatsApp', callsOf('create_note').length === 0 && /Fictional picnic/.test(question), question);
  const repliesBefore = texts().length;
  await post(`wamid.${++messageId}`, 'Approve');
  await until('reply after approval', () => texts().length > repliesBefore, 240_000);
  await pause(3000);
  step('after Approve the write reaches the server exactly once', callsOf('create_note', args => /Fictional picnic/.test(args.title)).length === 1 && callsOf('create_note').length === 1, { calls: callsOf('create_note'), reply: texts().slice(repliesBefore) });

  // Write, denied: the server never sees it.
  const deniedBefore = questions().length;
  await post(`wamid.${++messageId}`, 'Use the notes__create_note tool to create a note titled "Fictional storm" with the body "close the fictional shutters". Do not ask me anything first, just call the tool.');
  await until('second approval question', () => questions().slice(deniedBefore).some(text => /notes__create_note/.test(text)));
  const deniedReplies = texts().length;
  await post(`wamid.${++messageId}`, 'Deny');
  await until('reply after deny', () => texts().length > deniedReplies, 240_000);
  await pause(3000);
  step('after Deny the write never reaches the server', callsOf('create_note', args => /storm/i.test(args.title)).length === 0 && callsOf('create_note').length === 1, texts().slice(deniedReplies));
  step('the never-allowed tool was never called', callsOf('delete_all_notes').length === 0);

  // The header secret: every request to the server carried it, and it is nowhere in the transcript or the replies.
  const entries = await transcript(whatsappId);
  step('the x-api-key header reached the server on every request', notes.requests.length > 0 && notes.requests.every(item => item.keyOk), { requests: notes.requests.length });
  step('the secret is not in the transcript, the replies or the Worker log', entries.length > 0 && !JSON.stringify(entries).includes(API_KEY) && !JSON.stringify(sent).includes(API_KEY) && !worker.log().includes(API_KEY), { entries: entries.length });

  // Object reset: the manager restores the server from the object's SQLite and the tool still works.
  const instance = (await (await api('/api/agent')).json()).instance;
  await api('/api/debug/restart', { method: 'POST' }).catch(() => undefined);
  await until('object restarted', async () => { try { return (await (await api('/api/agent')).json()).instance !== instance; } catch { return false; } });
  const restored = (await (await api('/api/services?wait=1')).json()).servers?.find(item => item.id === 'notes');
  step('after a reset the server is reconnected from storage', restored?.state === 'ready', restored);
  const otters = await ask('Use the notes__search_notes tool again, this time for "otter". Reply with the exact title of the note it found and nothing else.');
  step('the tool still works after the reset', callsOf('search_notes', args => /otter/i.test(args.query)).length >= 1 && /otter count/i.test(otters), otters);

  // A conversation without a grant: its selection has no MCP extension, and asking for the tool never reaches the server.
  const created = await (await api('/api/conversations', { method: 'POST' })).json();
  const plain = await (await api(`/api/services?conversation=${created.conversationId}`)).json();
  step('a new web conversation is not granted and does not select the server', plain.granted === false && plain.selected?.length > 0 && !plain.selected.some(name => name.startsWith('mcp.')), plain.selected);
  const searchesBefore = callsOf('search_notes').length;
  const requestId = `journey-${randomBytes(4).toString('hex')}`;
  await api(`/api/chat?conversation=${created.conversationId}&op=submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, content: 'Use the notes__search_notes tool to search my notes for "heron". If you do not have that tool, reply exactly: NO TOOL.' }) });
  let record;
  await until('ungranted answer', async () => { record = (await (await api(`/api/chat?conversation=${created.conversationId}&op=submission&requestId=${requestId}`)).json()).record; return record && record.status !== 'queued' && record.status !== 'placed'; }, 240_000);
  const plainEntries = await transcript(created.conversationId);
  const declared = JSON.stringify(plainEntries).includes('notes__search_notes"');
  step('the ungranted conversation never reaches the server', callsOf('search_notes').length === searchesBefore, { status: record?.status });
  step('and no call to an MCP tool is in its transcript', !plainEntries.some(entry => (entry.model ?? []).some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && part.name.startsWith('notes__')))), { mentioned: declared });
  const grantedWeb = await (await api('/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ services: true }) })).json();
  const grantedView = await (await api(`/api/services?conversation=${grantedWeb.conversationId}`)).json();
  step('a web conversation created with services: true selects the server', grantedView.granted === true && grantedView.selected?.includes('mcp.notes') && !grantedView.selected.some(name => name.includes('optchat')), grantedView.selected);
} catch (error) {
  step('journey', false, String(error?.message ?? error));
} finally {
  const stopped = await worker.stop();
  graph.close(); await notes.close();
  step('wrangler dev stopped, its temporary state deleted, the default state and .dev.vars untouched', stopped.stopped && stopped.deleted && stopped.defaultsUntouched, stopped);
  writeFileSync('.cache/evidence/cloudflare-mcp.json', JSON.stringify({ at: new Date().toISOString(), model, steps,
    server: { calls: notes.calls, requests: notes.requests.length, rejected: notes.requests.filter(item => !item.keyOk).length },
    sent: sent.map(item => ({ type: item.body.type ?? item.body.status, text: item.body.text?.body ?? item.body.interactive?.body?.text })) }, null, 2).split(API_KEY).join('[secret]'));
  if (steps.some(item => !item.ok)) { console.log('\nwrangler log (tail):\n' + worker.log().split('\n').filter(line => !/CHATGPT|OPENAI|WHATSAPP_APP_SECRET|ACCESS_TOKEN|NOTES_API_KEY/.test(line)).slice(-50).join('\n').split(API_KEY).join('[secret]')); process.exitCode = 1; }
  setTimeout(() => process.exit(), 1000).unref();
}
