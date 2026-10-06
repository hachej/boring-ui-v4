// Signup journey against the recipe run locally by `wrangler dev`: the landing page, a fake OIDC hub (a tiny local issuer with a
// fictional Ed25519 key), the one-time code, signed WhatsApp webhooks "START <code>", each person's own agent answering, a second
// person isolated from the first, a view-link session held to its conversation, a per-person Composio session (a fake Composio API
// pointing at the fictional notes MCP server), the daily turn cap, and the SIGNUP_OPEN kill switch. It never contacts Meta, the real
// hub or Composio. Fictional numbers and people only.
//
//   CLOUDFLARE_API_TOKEN=... node examples/cloudflare/signup-journey.mjs
//
// Model and local state follow the other Cloudflare journeys (scripts/local-worker.mjs): Workers AI by default. Writes
// .cache/evidence/cloudflare-signup.json.
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign as signBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNotesServer } from './mcp-fixture.mjs';
import { journeyModel, startLocalWorker } from './scripts/local-worker.mjs';
import { signViewLink } from './src/view-links.mjs';

const PORT = Number(process.env.CF_PORT ?? 8797);
const OWNER = '15550001', ALICE = '15550100001', BOB = '15550100002', CAROL = '15550100003', ERIN = '15550100005', FRANK = '15550100006', HANA = '15550100007', STRANGER = '15550109999', PUBLIC_NUMBER = '15550100000';
const CLIENT_ID = 'fictional-agent-client', CLIENT_SECRET = randomBytes(16).toString('hex'), APP_KEY = `app_${randomBytes(16).toString('hex')}`, COMPOSIO_KEY = randomBytes(12).toString('hex');
const secrets = { WHATSAPP_ACCESS_TOKEN: 'fictional-access', WHATSAPP_APP_SECRET: randomBytes(16).toString('hex'), WHATSAPP_VERIFY_TOKEN: 'fictional-verify',
  WHATSAPP_PHONE_NUMBER_ID: '1000', WHATSAPP_ALLOWED: OWNER, ACCESS_TOKEN: randomBytes(16).toString('hex'), OIDC_CLIENT_SECRET: CLIENT_SECRET, HUB_APP_KEY: APP_KEY, COMPOSIO_API_KEY: COMPOSIO_KEY };
const model = journeyModel(secrets);

const steps = [];
const step = (name, ok, detail) => { steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); };
const until = async (label, check, ms = 120_000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error(`timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 250)); } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const readBody = async request => { let body = ''; for await (const chunk of request) body += chunk; return body; };
const b64url = buffer => Buffer.from(buffer).toString('base64url');

// ---- The fake hub: discovery, authorize (the person is whoever the journey says signs in next), token, JWKS, the app API. ----
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fictional-1', alg: 'EdDSA', use: 'sig' };
const hub = { next: undefined, codes: new Map(), authorizeParams: [], identities: [], tokenCalls: [], refreshes: [], tokens: new Map(), refreshTokens: new Map() };
// Access tokens live ACCESS_TTL seconds here (15 minutes at the hub), so a START sent later proves the refresh path.
const ACCESS_TTL = 4;
const issueAccess = (person, via) => { const token = `at-${person.sub}-${randomBytes(6).toString('hex')}`; hub.tokens.set(token, { person, via, expires: Date.now() + ACCESS_TTL * 1000 }); return token; };
const PEOPLE = { alice: { sub: 'sub-alice-fictional', email: 'alice@example.test' }, bob: { sub: 'sub-bob-fictional', email: 'bob@example.test' },
  carol: { sub: 'sub-carol-fictional', email: 'carol@example.test' }, dave: { sub: 'sub-dave-fictional', email: 'dave@example.test' },
  erin: { sub: 'sub-erin-fictional', email: 'erin@example.test' }, frank: { sub: 'sub-frank-fictional', email: 'frank@example.test' }, gina: { sub: 'sub-gina-fictional', email: 'gina@example.test' },
  hana: { sub: 'sub-hana-fictional', email: 'hana@example.test' } };
/** Subjects whose next refresh is throttled once (429 with Retry-After). */
hub.throttle = new Set();
// Carol's hub link fails (503, retryable) until the journey allows it after the restart: her pending link must survive it.
hub.carolDown = true;
let issuer;
const jwt = claims => { const head = b64url(JSON.stringify({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' })), body = b64url(JSON.stringify(claims)); return `${head}.${body}.${b64url(signBytes(null, Buffer.from(`${head}.${body}`), privateKey))}`; };
const hubServer = createServer(async (request, response) => {
  const url = new URL(request.url, issuer);
  const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
  if (url.pathname === '/api/auth/.well-known/openid-configuration') return send(200, { issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`,
    jwks_uri: `${issuer}/jwks`, id_token_signing_alg_values_supported: ['EdDSA'], token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'] });
  if (url.pathname === '/api/auth/jwks') return send(200, { keys: [jwk] });
  if (url.pathname === '/api/auth/oauth2/authorize') {
    const params = Object.fromEntries(url.searchParams);
    hub.authorizeParams.push(params);
    const person = PEOPLE[hub.next];
    const code = randomBytes(12).toString('hex');
    hub.codes.set(code, { person, params });
    response.writeHead(302, { location: `${params.redirect_uri}?code=${code}&state=${encodeURIComponent(params.state)}` }).end();
    return;
  }
  if (url.pathname === '/api/auth/oauth2/token' && request.method === 'POST') {
    const form = new URLSearchParams(await readBody(request));
    const basic = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    const grant = hub.codes.get(form.get('code'));
    hub.codes.delete(form.get('code'));
    const pkce = grant && b64url(createHash('sha256').update(form.get('code_verifier') ?? '').digest()) === grant.params.code_challenge;
    const ok = grant && pkce && basic === `${CLIENT_ID}:${CLIENT_SECRET}` && form.get('redirect_uri') === grant.params.redirect_uri && form.get('resource') === grant.params.resource;
    if (form.get('grant_type') === 'refresh_token') {
      const person = hub.refreshTokens.get(form.get('refresh_token'));
      const fine = person && basic === `${CLIENT_ID}:${CLIENT_SECRET}` && form.get('resource') === `${base}/api`;
      if (fine && hub.throttle.delete(person.sub)) {
        hub.refreshes.push({ ok: true, sub: person.sub, status: 429 });
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' }).end(JSON.stringify({ error: 'slow_down' }));
        return;
      }
      hub.refreshes.push({ ok: Boolean(fine), sub: person?.sub, status: fine ? 200 : 400 });
      if (!fine) return send(400, { error: 'invalid_grant' });
      // Rotation: the old refresh token is spent, a new one is issued.
      hub.refreshTokens.delete(form.get('refresh_token'));
      const refreshToken = `rt-${randomBytes(8).toString('hex')}`;
      hub.refreshTokens.set(refreshToken, person);
      return send(200, { token_type: 'Bearer', expires_in: ACCESS_TTL, access_token: issueAccess(person, 'refresh'), refresh_token: refreshToken, scope: 'openid email profile offline_access hub:whatsapp' });
    }
    hub.tokenCalls.push({ ok: Boolean(ok), pkce: Boolean(pkce), basic: basic === `${CLIENT_ID}:${CLIENT_SECRET}` });
    if (!ok) return send(400, { error: 'invalid_grant' });
    const now = Math.floor(Date.now() / 1000), accessToken = issueAccess(grant.person, 'code');
    grant.person.accessToken = accessToken;
    const offline = grant.params.scope.split(' ').includes('offline_access');
    const refreshToken = offline ? `rt-${randomBytes(8).toString('hex')}` : undefined;
    if (refreshToken) hub.refreshTokens.set(refreshToken, grant.person);
    return send(200, { token_type: 'Bearer', expires_in: ACCESS_TTL, access_token: accessToken, scope: grant.params.scope, ...(refreshToken ? { refresh_token: refreshToken } : {}),
      id_token: jwt({ iss: issuer, aud: CLIENT_ID, sub: grant.person.sub, email: grant.person.email, email_verified: true, nonce: grant.params.nonce, iat: now, exp: now + 300, auth_time: now }) });
  }
  if (url.pathname === '/v1/app/whatsapp-identity' && request.method === 'POST') {
    // As the hub: the person comes from the verified, unexpired token only; the app key names no person.
    const body = JSON.parse(await readBody(request));
    const token = hub.tokens.get(body.subjectToken);
    const live = token && token.expires > Date.now();
    hub.identities.push({ appKey: request.headers.authorization === `Bearer ${APP_KEY}`, live: Boolean(live), via: token?.via, sub: token?.person.sub, keys: Object.keys(body).sort(), phone: body.phone, linkedAfterRestart: hub.carolDown === false });
    if (!live) return send(401, { error: { code: 'invalid_user_proof', message: 'expired or unknown', retryable: false } });
    if (token.person.sub === PEOPLE.carol.sub && hub.carolDown) return send(503, { error: { code: 'unavailable', message: 'fictional outage', retryable: true } });
    return send(200, { linked: true, created: true, subject: token.person.sub, issuer, phone: body.phone, personId: `person-${token.person.sub}`, email: token.person.email });
  }
  send(404, { error: 'not_found' });
});
issuer = `${await listen(hubServer)}/api/auth`;

// ---- Fake Composio session API: one session per user_id, pointing at the fictional notes MCP server. ----
const notes = await startNotesServer({ apiKey: COMPOSIO_KEY });
const composio = { sessions: [] };
const composioServer = createServer(async (request, response) => {
  const body = JSON.parse(await readBody(request) || '{}');
  composio.sessions.push({ path: request.url, keyOk: request.headers['x-api-key'] === COMPOSIO_KEY, userId: body.user_id, manage: body.manage_connections });
  response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ session_id: `trs_${body.user_id}`, mcp: { type: 'http', url: notes.url } }));
});
const composioOrigin = await listen(composioServer);

// ---- Graph API stand-in. ----
const sent = [];
const graph = createServer(async (request, response) => { sent.push({ path: request.url, body: JSON.parse(await readBody(request) || '{}') }); response.writeHead(200, { 'content-type': 'application/json' }).end('{"messages":[{"id":"wamid.out"}]}'); });
const graphOrigin = await listen(graph);
const textsTo = to => sent.filter(item => item.body.type === 'text' && item.body.to === to).map(item => item.body.text.body);

const vars = open => ({ ...secrets, WHATSAPP_GRAPH_ORIGIN: graphOrigin, HUB_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT_ID, WHATSAPP_PUBLIC_NUMBER: `+${PUBLIC_NUMBER}`,
  SIGNUP_OPEN: open ? '1' : '0', SIGNUP_DAILY_TURNS: '3', COMPOSIO_API_ORIGIN: composioOrigin, HUB_LINK_RETRY_MS: Array(40).fill(10_000).join(','), ENABLE_DEBUG_ROUTES: '1' });
mkdirSync('.cache/evidence', { recursive: true });
// One isolated state directory for both runs: the restart continues the same Durable Object storage.
const state = mkdtempSync(join(tmpdir(), 'signup-journey-state-'));
let worker = await startLocalWorker({ name: 'signup-journey', port: PORT, vars: vars(true), persist: state });
const base = worker.base;

// A browser of one person: a cookie jar over fetch, no redirects followed (each hop is checked).
function browser() {
  const jar = new Map();
  const go = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await fetch(url.startsWith('http') ? url : `${base}${url}`, { ...init, headers, redirect: 'manual' });
    for (const line of response.headers.getSetCookie()) { const [pair, ...attributes] = line.split(';'); const at = pair.indexOf('='); const name = pair.slice(0, at), value = pair.slice(at + 1);
      if (/max-age=0/i.test(attributes.join(';')) || !value) jar.delete(name); else jar.set(name, value); }
    return response;
  };
  return { go, jar };
}
const envelope = (...items) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1000' },
  contacts: items.map(([, , from]) => ({ wa_id: from, profile: { name: 'Fictional' } })), messages: items.map(([id, text, from]) => ({ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } })) } }] }] });
/** One signed webhook carrying one message, or several (`[[id, text, from], ...]`, a mixed-sender batch). */
const whatsapp = async (id, text, from) => { const body = Array.isArray(id) ? envelope(...id) : envelope([id, text, from]); const response = await fetch(`${base}/whatsapp`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secrets.WHATSAPP_APP_SECRET).update(body).digest('hex')}` } }); return { status: response.status, body: await response.json().catch(() => null) }; };

/** A person's object name, as the Worker derives it. */
const objectOf = who => `p-${createHash('sha256').update(`${issuer}\n${PEOPLE[who].sub}`).digest('hex').slice(0, 32)}`;
/** A proof route of one object (operator token; ENABLE_DEBUG_ROUTES=1 in this journey only). */
const debugRoute = (who, path, init = {}) => fetch(`${base}/api/debug/${path}${path.includes('?') ? '&' : '?'}object=${objectOf(who)}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${secrets.ACCESS_TOKEN}`, 'content-type': 'application/json' } });
const arm = (who, name) => debugRoute(who, 'crashpoints', { method: 'POST', body: JSON.stringify({ name }) });
const reservations = async (who, reconcile = false) => (await (await debugRoute(who, `turns${reconcile ? '?reconcile=1' : ''}`)).json()).reservations;

/** Landing → POST /signup (a new number, or `mode=login` for a returning person) → hub authorize → callback. */
async function signUp(who, phone) {
  const tab = browser();
  hub.next = who;
  const started = await tab.go('/signup', { method: 'POST', body: new URLSearchParams(phone ? { phone } : { mode: 'login' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const authorize = started.headers.get('location') ?? '';
  const atHub = await fetch(authorize, { redirect: 'manual' });
  const callback = atHub.headers.get('location') ?? '';
  const done = await tab.go(callback);
  const html = await done.text();
  const code = /START ([A-Z0-9]{6})/.exec(html)?.[1];
  const wa = /href="(https:\/\/wa\.me\/[^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
  return { tab, started, authorize, callback, done, html, code, wa };
}

try {
  console.log(`model: ${model}; fake hub ${issuer}`);
  await until('wrangler dev ready', async () => { try { return (await fetch(`${base}/api/agent`)).status === 401; } catch { return false; } }, 90_000);

  // 1. Landing and manifest.
  const landing = await fetch(`${base}/`);
  const landingHtml = await landing.text();
  step('signed out, / is the landing page: phone input, "Get my agent", light and dark', landing.status === 200 && /data-testid="signup-form"/.test(landingHtml) && /Get my agent/.test(landingHtml) && /prefers-color-scheme:dark/.test(landingHtml) && /\+41 79/.test(landingHtml));
  step('the landing page relies on no secure-context-only API (plain HTTP works)', !/randomUUID|clipboard|crypto\.subtle/.test(landingHtml));
  const boring = await fetch(`${base}/.well-known/boring.json`);
  const manifest = await boring.json();
  step('/.well-known/boring.json is the app manifest of the contract', boring.status === 200 && /application\/json/.test(boring.headers.get('content-type') ?? '') && manifest.protocol === 1 && manifest.name === 'boring-whatsapp-agent'
    && manifest.version === '0.1.0' && typeof manifest.description === 'string' && ['agents', 'jobs', 'conversations', 'tools'].every(key => Array.isArray(manifest[key])), manifest);
  const invalid = await fetch(`${base}/signup`, { method: 'POST', body: 'phone=12', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  step('an invalid number is refused on the landing page', invalid.status === 400 && /signup-error/.test(await invalid.text()));
  // An unauthenticated form streamed without Content-Length (chunked, 64 KiB) is refused once it passes the 2 KiB cap. (wrangler dev's
  // local proxy drains request bodies itself, so the client sends the whole body here; the Worker stops reading at the cap.)
  let streamed = 0;
  const oversized = await new Promise(resolve => {
    const request = httpRequest(`${base}/signup`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } });
    request.on('response', response => { response.resume(); resolve({ status: response.statusCode }); });
    request.on('error', error => resolve({ status: String(error.message) }));
    for (let index = 0; index < 16; index++) { request.write(Buffer.alloc(4096, 97)); streamed += 4096; }
    request.end();
  });
  step('an oversized signup form without Content-Length is refused (413) by a capped streaming read', oversized.status === 413, { status: oversized.status, sentKiB: Math.round(streamed / 1024) });

  // 2. Alice signs up through the fake hub.
  const alice = await signUp('alice', `+${ALICE.slice(0, 1)} ${ALICE.slice(1, 4)} ${ALICE.slice(4)}`);
  const params = hub.authorizeParams.at(-1) ?? {};
  step('POST /signup sends the browser to the discovered authorize endpoint with code + PKCE S256, state, nonce and the resource',
    alice.started.status === 303 && alice.authorize.startsWith(`${issuer}/oauth2/authorize`) && params.response_type === 'code' && params.code_challenge_method === 'S256' && params.code_challenge?.length >= 43
    && params.state?.length >= 32 && params.nonce?.length >= 32 && params.client_id === CLIENT_ID && params.redirect_uri === `${base}/auth/callback` && params.resource === `${base}/api` && params.scope === 'openid email profile offline_access hub:whatsapp',
    { scope: params.scope, resource: params.resource });
  step('the code exchange used client_secret_basic and the PKCE verifier', hub.tokenCalls.at(-1)?.ok === true, hub.tokenCalls.at(-1));
  step('the callback shows a 6-character code and the wa.me link with "START <code>"', alice.done.status === 200 && /^[A-HJ-NP-Z2-9]{6}$/.test(alice.code ?? '') && alice.wa === `https://wa.me/${PUBLIC_NUMBER}?text=START%20${alice.code}`, { code: alice.code, wa: alice.wa });
  step('the callback set the person\'s session cookie (HttpOnly) and cleared the sign-in state', alice.tab.jar.has('boring_session') && !alice.tab.jar.has('boring_signin'));
  // A callback whose state does not match the cookie is refused (a forged or replayed redirect).
  const forged = browser();
  hub.next = 'bob';
  const forgedStart = await forged.go('/signup', { method: 'POST', body: new URLSearchParams({ phone: `+${BOB}` }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const forgedHop = (await fetch(forgedStart.headers.get('location'), { redirect: 'manual' })).headers.get('location').replace(/state=[^&]+/, 'state=forged');
  const forgedDone = await forged.go(forgedHop);
  step('a callback with a state that does not match is refused, no session', forgedDone.status === 400 && !forged.jar.has('boring_session'));

  // Before START the session is onboarding only: no agent, no model, no services; / is still the landing page.
  const early = await alice.tab.go('/api/chat?conversation=1&op=submit', { method: 'POST', body: JSON.stringify({ requestId: 'early', content: 'hi' }), headers: { 'content-type': 'application/json', origin: base } });
  const earlyAgent = await alice.tab.go('/api/agent');
  const earlyPage = await (await alice.tab.go('/')).text();
  step('a session before START is onboarding only: chat and agent 403 (phone-not-linked), / is the landing page',
    early.status === 403 && earlyAgent.status === 403 && (await earlyAgent.json()).reason === 'phone-not-linked' && /signup-form/.test(earlyPage), { chat: early.status, agent: earlyAgent.status });

  // 3. START from the wrong number, then from Alice's, after her 4-second access token has expired.
  await pause((ACCESS_TTL + 1) * 1000);
  const wrong = await whatsapp('wamid.w1', `START ${alice.code}`, STRANGER);
  await until('refusal', () => textsTo(STRANGER).length >= 1);
  step('START with a code claimed for another number is refused with a pointer to the landing page', wrong.status === 200 && /not valid or has expired/.test(textsTo(STRANGER)[0]) && textsTo(STRANGER)[0].includes(base), textsTo(STRANGER)[0]);
  const linked = await whatsapp('wamid.a1', `start ${alice.code.toLowerCase()}`, ALICE);
  await until('welcome', () => textsTo(ALICE).length >= 1);
  step('START <code> from the claimed number links it and answers "You\'re set up"', linked.status === 200 && /set up/.test(textsTo(ALICE)[0]), textsTo(ALICE)[0]);
  await until('hub identity call', () => hub.identities.some(item => item.live), 30_000);
  const identity = hub.identities.find(item => item.live);
  step('START after the sign-in access token expired still links at the hub: the job refreshed the token first (refresh grant, client_secret_basic, the resource)',
    hub.refreshes.length >= 1 && hub.refreshes.every(item => item.ok) && identity.via === 'refresh' && hub.tokens.get(PEOPLE.alice.accessToken).expires < Date.now(), { refreshes: hub.refreshes.length, via: identity.via });
  step('the hub is told: POST /v1/app/whatsapp-identity { subjectToken, phone } with the app key; the person comes from the token only',
    identity.appKey && identity.phone === `+${ALICE}` && identity.sub === PEOPLE.alice.sub && JSON.stringify(identity.keys) === JSON.stringify(['phone', 'subjectToken']), identity);
  const reused = await whatsapp('wamid.a2', `START ${alice.code}`, ALICE);
  await until('reuse refusal', () => textsTo(ALICE).length >= 2);
  step('the same code a second time (a new message) is refused: single use', reused.status === 200 && /not valid/.test(textsTo(ALICE)[1]));

  // 4. Alice's own agent answers on WhatsApp.
  const first = await whatsapp('wamid.a3', 'Reply with exactly the words: fictional alpaca', ALICE);
  step('Alice\'s message is admitted by her own object', first.status === 200 && first.body?.accepted === 1, first.body);
  await until('alice answer', () => textsTo(ALICE).some(text => /fictional alpaca/i.test(text)), 180_000);
  step('her agent answers her on WhatsApp', true, textsTo(ALICE).at(-1));

  // 5. Her web session: her object only, Workers AI only, writes from this origin only, no debug.
  const asAlice = (path, init = {}) => alice.tab.go(path, init);
  const page = await asAlice('/');
  step('signed in, / is the web app, not the landing page', page.status === 200 && /id="root"/.test(await page.text()));
  const agent = await (await asAlice('/api/agent')).json();
  step('her session is a person session and her models are Workers AI only (never the owner\'s ChatGPT)', agent.access === 'person' && agent.models.every(item => item.provider !== 'openai-codex' && !/openai/i.test(item.provider)), agent.models.map(item => item.modelId));
  const aliceList = (await (await asAlice('/api/conversations')).json()).conversations ?? [];
  const aliceConversation = aliceList.find(item => /fictional alpaca/.test(item.title ?? ''))?.id;
  step('her WhatsApp conversation is in her web history', aliceConversation !== undefined, aliceList.map(item => item.title));
  const crossSite = await asAlice('/api/conversations', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
  const sameSite = await asAlice('/api/conversations', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: base } });
  step('a cookie write from another origin is refused, from this origin accepted', crossSite.status === 401 && sameSite.status === 200, { crossSite: crossSite.status, sameSite: sameSite.status });
  const debug = await asAlice('/api/debug/holds');
  step('debug routes stay operator-only', debug.status === 401);

  // 6. Her own Composio session (user_id = her object), created on first need, on the fictional MCP server.
  const services = await (await asAlice(`/api/services?conversation=${aliceConversation}&wait=1`)).json();
  const aliceSession = composio.sessions.find(item => item.userId?.startsWith('p-'));
  step('her first granted turn created her own Composio Tool Router session (key sent, user_id = her person id, connections managed)',
    Boolean(aliceSession) && aliceSession.keyOk && aliceSession.path === '/api/v3.1/tool_router/session' && aliceSession.manage?.enable === true, aliceSession);
  step('her composio server is connected for her WhatsApp conversation', services.granted === true && services.servers?.some(item => item.id === 'composio' && item.state === 'ready'), services.servers);

  // 7. Bob: a second person, isolated from Alice.
  const bob = await signUp('bob', `+${BOB}`);
  await whatsapp('wamid.b1', `START ${bob.code}`, BOB);
  await until('bob welcome', () => textsTo(BOB).length >= 1);
  await whatsapp('wamid.b2', 'Reply with exactly the words: fictional bison', BOB);
  await until('bob answer', () => textsTo(BOB).some(text => /fictional bison/i.test(text)), 180_000);
  step('Bob signs up and his own agent answers him', true, textsTo(BOB).at(-1));
  const bobList = (await (await bob.tab.go('/api/conversations')).json()).conversations ?? [];
  step('Bob\'s web history has his conversation and none of Alice\'s', bobList.some(item => /fictional bison/.test(item.title ?? '')) && !bobList.some(item => /alpaca/.test(item.title ?? '')), bobList.map(item => item.title));
  const bobChatOnAlice = await bob.tab.go(`/api/chat?conversation=${aliceConversation}&op=entries&limit=5`);
  const bobEntries = await bobChatOnAlice.json().catch(() => ({}));
  step('Bob cannot read Alice\'s conversation id (it does not exist in his object)', bobChatOnAlice.status !== 200 || !JSON.stringify(bobEntries).includes('alpaca'), bobChatOnAlice.status);
  const bobSessionComposio = composio.sessions.filter(item => item.userId?.startsWith('p-'));
  step('Alice never received Bob\'s messages, Bob never Alice\'s', !textsTo(ALICE).some(text => /bison/i.test(text)) && !textsTo(BOB).some(text => /alpaca/i.test(text)));
  const ownerList = (await (await fetch(`${base}/api/conversations`, { headers: { authorization: `Bearer ${secrets.ACCESS_TOKEN}` } })).json()).conversations ?? [];
  step('the operator token reaches the owner\'s object only: neither person\'s conversation is there', !ownerList.some(item => /alpaca|bison/.test(item.title ?? '')), ownerList.map(item => item.title));

  // 8. A view link's session: its object, its conversation only.
  const aliceObject = aliceSession?.userId;
  const link = await signViewLink(secrets.ACCESS_TOKEN, { kind: 'notes', conversation: String(aliceConversation), object: aliceObject });
  const exchanged = await (await fetch(`${base}/api/session`, { method: 'POST', body: JSON.stringify({ link }), headers: { 'content-type': 'application/json' } })).json();
  const asLink = path => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${exchanged.token}` } });
  const linkList = (await (await asLink('/api/conversations')).json()).conversations ?? [];
  const other = aliceList.find(item => item.id !== aliceConversation)?.id ?? (await (await asAlice('/api/conversations')).json()).conversations.find(item => item.id !== aliceConversation)?.id;
  const linkOther = await asLink(`/api/chat?conversation=${other}&op=entries&limit=5`);
  const linkOwn = await asLink(`/api/chat?conversation=${aliceConversation}&op=entries&limit=5`);
  const linkCreate = await fetch(`${base}/api/conversations`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${exchanged.token}`, 'content-type': 'application/json' } });
  step('a view-link session sees only its conversation, reads it, and cannot open another or create one',
    linkList.length === 1 && linkList[0].id === aliceConversation && linkOwn.status === 200 && linkOther.status === 403 && linkCreate.status === 403,
    { listed: linkList.map(item => item.id), own: linkOwn.status, other: linkOther.status, create: linkCreate.status });

  // 8b. A mixed-sender batch: one webhook with Alice's and Bob's messages; each object gets only its own (split and re-signed).
  const mixed = await whatsapp([['wamid.mx1', 'Reply with exactly the words: fictional heron', ALICE], ['wamid.mx2', 'Reply with exactly the words: fictional otter', BOB]]);
  await until('mixed answers', () => textsTo(ALICE).some(text => /heron/i.test(text)) && textsTo(BOB).some(text => /otter/i.test(text)), 180_000);
  const aliceEntries = JSON.stringify(await (await asAlice(`/api/chat?conversation=${aliceConversation}&op=entries&limit=50`)).json());
  step('a mixed-sender batch is split per object: each person answered by their own agent, neither transcript holds the other\'s message',
    mixed.body?.accepted === 2 && !textsTo(ALICE).some(text => /otter/i.test(text)) && !textsTo(BOB).some(text => /heron/i.test(text)) && aliceEntries.includes('heron') && !aliceEntries.includes('otter'), mixed.body);

  // 8c. A number that already belongs to a person is never moved: Dave claims Alice's number, START from it is refused.
  const dave = await signUp('dave', `+${ALICE}`);
  await whatsapp('wamid.d1', `START ${dave.code}`, ALICE);
  await until('owned refusal', () => textsTo(ALICE).some(text => /already linked/.test(text)), 30_000);
  step('START for a number another person owns is refused (contact the operator); the hub is not told', !hub.identities.some(item => item.sub === PEOPLE.dave.sub), textsTo(ALICE).at(-1));

  // 8d. Two concurrent STARTs with the same code (two message ids): exactly one links.
  const carol = await signUp('carol', `+${CAROL}`);
  const both = await Promise.all([whatsapp('wamid.cc1', `START ${carol.code}`, CAROL), whatsapp('wamid.cc2', `START ${carol.code}`, CAROL)]);
  await until('carol replies', () => textsTo(CAROL).length >= 2, 30_000);
  step('two concurrent STARTs with one code: exactly one "set up", the other refused', both.every(item => item.status === 200)
    && textsTo(CAROL).filter(text => /set up/.test(text)).length === 1 && textsTo(CAROL).filter(text => /not valid/.test(text)).length === 1, textsTo(CAROL));
  await until('carol link attempted', () => hub.identities.some(item => item.sub === PEOPLE.carol.sub), 30_000);
  step('Carol\'s hub link meets an outage (503, retryable): pending, not lost', true);

  // 8e. Crash points (debug-only, deterministic): the turn reservation, the phone adoption and the refreshed-grant write.
  const carolList = (await (await carol.tab.go('/api/conversations')).json()).conversations ?? [];
  const carolConversation = carolList.at(-1)?.id;
  const submitAs = (tab, conversationId, requestId, content) => tab.go(`/api/chat?conversation=${conversationId}&op=submit`, { method: 'POST', body: JSON.stringify({ requestId, content }), headers: { 'content-type': 'application/json', origin: base } });
  await arm('carol', 'after-reserve');
  const crashed = await submitAs(carol.tab, carolConversation, 'crash-1', 'Reply with exactly the words: fictional ibis').then(response => response.status, () => 'network');
  await until('carol object back', async () => (await debugRoute('carol', 'turns')).status === 200, 30_000);
  const afterCrash = await reservations('carol');
  const retried = await submitAs(carol.tab, carolConversation, 'crash-1', 'Reply with exactly the words: fictional ibis');
  const afterRetry = await reservations('carol');
  const crashKeys = state => Object.entries(state).filter(([key]) => key.endsWith(':crash-1'));
  step('a crash between the turn reservation and the submission: the retry of the same request reuses its reservation (charged once) and lands',
    crashed !== 200 && crashKeys(afterCrash).length === 1 && !crashKeys(afterCrash)[0][1].landed && retried.status === 200 && crashKeys(afterRetry).length === 1 && crashKeys(afterRetry)[0][1].landed === true
    && Object.keys(afterRetry).length === 1, { crashed, retried: retried.status, reservations: Object.keys(afterRetry).length });
  await arm('carol', 'after-reserve');
  await submitAs(carol.tab, carolConversation, 'crash-2', 'never submitted').catch(() => undefined);
  await until('carol object back again', async () => (await debugRoute('carol', 'turns')).status === 200, 30_000);
  const beforeReconcile = await reservations('carol'), reconciled = await reservations('carol', true);
  step('a reservation whose submission never reached Pi is released by reconciliation; the landed one stays',
    Object.keys(beforeReconcile).some(key => key.endsWith(':crash-2')) && !Object.keys(reconciled).some(key => key.endsWith(':crash-2')) && Object.keys(reconciled).some(key => key.endsWith(':crash-1')), Object.keys(reconciled));

  const erin = await signUp('erin', `+${ERIN}`);
  await arm('erin', 'after-adopt-write');
  hub.throttle.add(PEOPLE.erin.sub);
  const erinFirst = await whatsapp('wamid.e1', `START ${erin.code}`, ERIN);
  const erinAgain = await whatsapp('wamid.e1', `START ${erin.code}`, ERIN);
  await until('erin linked at the hub', () => hub.identities.some(item => item.sub === PEOPLE.erin.sub && item.live), 120_000);
  const erinRefreshes = hub.refreshes.filter(item => item.sub === PEOPLE.erin.sub).map(item => item.status);
  step('a crash right after the phone adoption write: Meta\'s redelivery is answered and the hub link (written with the adoption) still happens',
    erinFirst.status !== 200 && erinAgain.status === 200 && textsTo(ERIN).some(text => /set up/.test(text)), { first: erinFirst.status, again: erinAgain.status });
  step('a throttled refresh (429, Retry-After) keeps the obligation and grant: retried, then linked', erinRefreshes[0] === 429 && erinRefreshes.includes(200), erinRefreshes);

  const frank = await signUp('frank', `+${FRANK}`);
  await arm('frank', 'after-grant-refresh');
  await whatsapp('wamid.f1', `START ${frank.code}`, FRANK);
  await until('frank linked at the hub', () => hub.identities.some(item => item.sub === PEOPLE.frank.sub && item.live), 180_000);
  const frankRefreshes = hub.refreshes.filter(item => item.sub === PEOPLE.frank.sub);
  step('a crash right after the rotated grant was stored: the restarted job uses the rotated refresh token (no invalid_grant) and links',
    frankRefreshes.length >= 2 && frankRefreshes.every(item => item.status === 200), frankRefreshes.map(item => item.status));

  // 8f. The Worker dies between the registry's redemption and the agent's adoption: the registry's alarm completes the adoption.
  const hana = await signUp('hana', `+${HANA}`);
  await fetch(`${base}/api/debug/registry-crashpoint`, { method: 'POST', body: JSON.stringify({ name: 'after-redeem' }), headers: { authorization: `Bearer ${secrets.ACCESS_TOKEN}`, 'content-type': 'application/json' } });
  const hanaFirst = await whatsapp('wamid.h1', `START ${hana.code}`, HANA);
  await until('hana adopted by the registry alarm and linked at the hub', () => hub.identities.some(item => item.sub === PEOPLE.hana.sub && item.live), 120_000);
  const hanaAgent = await hana.tab.go('/api/agent');
  step('a Worker crash between redemption and adoption: no redelivery needed, the registry alarm adopts (hub linked, web access open)',
    hanaFirst.status === 500 && !textsTo(HANA).some(text => /set up/.test(text)) && hanaAgent.status === 200, { first: hanaFirst.status, agent: hanaAgent.status });
  const daveAgent = await dave.tab.go('/api/agent');
  step('a refused enrollment (number owned by someone else) keeps an onboarding-only session', daveAgent.status === 403);

  // 9. The daily turn cap (SIGNUP_DAILY_TURNS=3): Alice used two turns; the third is answered, the fourth gets the friendly limit.
  await whatsapp('wamid.a4', 'Reply with exactly the word: fictional okapi', ALICE);
  await until('second answer', () => textsTo(ALICE).some(text => /okapi/i.test(text)), 180_000);
  const capped = await whatsapp('wamid.a5', 'Reply with exactly the word: fictional quokka', ALICE);
  await until('limit notice', () => textsTo(ALICE).some(text => /limit/i.test(text)), 30_000);
  const webCapped = await asAlice(`/api/chat?conversation=${aliceConversation}&op=submit`, { method: 'POST', body: JSON.stringify({ requestId: 'web-capped', content: 'hi' }), headers: { 'content-type': 'application/json', origin: base } });
  step('past the daily cap: a friendly WhatsApp message and a 429 on the web, before any submission', capped.body?.accepted === 0 && webCapped.status === 429 && /limit/.test((await webCapped.json()).reason ?? ''), textsTo(ALICE).at(-1));

  // 10. Unknown number: told where to sign up, once.
  await whatsapp('wamid.u1', 'hello?', '15550109998');
  await whatsapp('wamid.u2', 'hello again?', '15550109998');
  await pause(1500);
  step('an unknown number without START is told to sign up, once a day', textsTo('15550109998').length === 1 && /sign up at/i.test(textsTo('15550109998')[0]), textsTo('15550109998'));

  // 11. The owner keeps 'main' and is answered as before.
  const ownerMessage = await whatsapp('wamid.o1', 'Reply with exactly the words: fictional owl', OWNER);
  step('the owner\'s allow-listed number still goes to the owner\'s object', ownerMessage.body?.accepted === 1, ownerMessage.body);
  step('Composio sessions: one per person, never shared', new Set(bobSessionComposio.map(item => item.userId)).size === bobSessionComposio.length, bobSessionComposio.map(item => item.userId));

  // 12. Restart on the SAME storage with SIGNUP_OPEN=0: existing people, quota and the pending hub link survive; signups are closed.
  step('wrangler dev (open) stopped, its state kept for the restart', Object.values(await worker.stop()).every(Boolean) && existsSync(state));
  hub.carolDown = false;
  worker = await startLocalWorker({ name: 'signup-journey-closed', port: PORT, vars: vars(false), persist: state });
  await until('wrangler dev ready (closed)', async () => { try { return (await fetch(`${base}/api/agent`)).status === 401; } catch { return false; } }, 90_000);
  const bobBefore = textsTo(BOB).length;
  const bobAfter = await whatsapp('wamid.b9', 'Reply with exactly the words: fictional walrus', BOB);
  // Any answer from his agent (the model's wording is not what this checks).
  await until('bob after restart', () => textsTo(BOB).length > bobBefore, 180_000);
  step('after the restart, with signups closed, an existing person\'s number still routes to their agent', bobAfter.body?.accepted === 1);
  const limitBefore = textsTo(ALICE).filter(text => /limit/.test(text)).length;
  const aliceAfter = await whatsapp('wamid.a9', 'Reply with exactly the word: fictional lynx', ALICE);
  await until('alice still capped', () => textsTo(ALICE).filter(text => /limit/.test(text)).length > limitBefore, 30_000);
  step('her used quota survived the restart: still capped today', aliceAfter.body?.accepted === 0 && !textsTo(ALICE).some(text => /lynx/i.test(text)));
  await until('carol linked after restart', () => hub.identities.some(item => item.sub === PEOPLE.carol.sub && item.live && !hub.carolDown && item.linkedAfterRestart), 300_000);
  step('Carol\'s pending hub link survived the restart and landed once the hub was back', true, hub.identities.filter(item => item.sub === PEOPLE.carol.sub).length);
  // A returning person signs in on the web while sign-ups are closed; an unknown one cannot.
  const aliceBack = await signUp('alice');
  const aliceAgent = await aliceBack.tab.go('/api/agent');
  step('signups closed: a returning person signs in again (no phone, no code) and reaches their own agent', aliceBack.done.status === 303 && aliceBack.tab.jar.has('boring_session') && aliceAgent.status === 200, aliceBack.done.status);
  const gina = await signUp('gina');
  step('signups closed: an unknown person\'s sign-in is refused, no session', gina.done.status === 400 && !gina.tab.jar.has('boring_session'));
  // The redelivery of Hana's committed START, while closed and after her code may be gone: still completed, not "closed".
  await whatsapp('wamid.h1', `START ${hana.code}`, HANA);
  await until('hana replay reply', () => textsTo(HANA).length >= 1, 30_000);
  step('a redelivered, already-committed START completes while sign-ups are closed', /set up/.test(textsTo(HANA)[0]), textsTo(HANA)[0]);
  const closedStart = await whatsapp('wamid.a10', `START ${alice.code}`, ALICE);
  await until('closed start reply', () => textsTo(ALICE).some(text => /closed/i.test(text)), 30_000);
  step('a START (even of a redeemed code) is refused while signups are closed', closedStart.status === 200);
  const closedLanding = await (await fetch(`${base}/`)).text();
  const closedSignup = await fetch(`${base}/signup`, { method: 'POST', body: `phone=%2B${ALICE}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  await whatsapp('wamid.c1', 'START ABCDEF', '15550109997');
  await until('closed reply', () => textsTo('15550109997').length >= 1, 30_000);
  step('SIGNUP_OPEN unset: the landing says closed, /signup does not start a sign-in, START is refused', /closed/.test(closedLanding) && !/signup-form/.test(closedLanding) && closedSignup.status === 200 && /closed/i.test(textsTo('15550109997')[0]), textsTo('15550109997')[0]);
} catch (error) {
  step('journey', false, { error: String(error?.stack ?? error).slice(0, 800), alice: textsTo(ALICE).slice(-4), bob: textsTo(BOB).slice(-3) });
} finally {
  const stopped = await worker.stop();
  rmSync(state, { recursive: true, force: true });
  step('wrangler dev stopped, its temporary state deleted, default state untouched', Object.values(stopped).every(Boolean) && !existsSync(state), stopped);
  hubServer.close(); composioServer.close(); graph.close(); await notes.close();
  writeFileSync('.cache/evidence/cloudflare-signup.json', JSON.stringify({ at: new Date().toISOString(), model, steps }, null, 2));
  const failed = steps.filter(item => !item.ok);
  console.log(failed.length ? `${failed.length} step(s) failed` : `all ${steps.length} steps passed`);
  if (worker.log && failed.length) writeFileSync('.cache/evidence/cloudflare-signup.log', worker.log().slice(-20000));
  process.exit(failed.length ? 1 : 0);
}
