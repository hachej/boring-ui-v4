// Public signup: anyone gets their own agent. The Worker side of the flow (the hub's side is its own repository):
//
//   GET  /                the landing page when signed out (phone number, "Get my agent"); the web app when signed in
//   POST /signup          the claimed number is kept in a signed, short-lived cookie with the OIDC state, nonce and PKCE verifier,
//                         and the browser goes to the hub's sign-in (oidc.mjs)
//   GET  /auth/callback   the hub's answer: code exchanged, id_token verified, the person's web session cookie set, a one-time code
//                         issued (registry.mjs) and the page sends the person to WhatsApp with "START <code>" ready to send
//   POST /whatsapp        "START <code>" from the claimed number links the number to the person (the registry routes it from then
//                         on, the hub is told best effort, see hub.mjs); other messages go to the sender's own object
//
// One object per person: `env.ASSISTANT.getByName(personObject(...))`, a stable id derived from the hub issuer and subject. The owner
// keeps 'main' (OWNER_SUBJECT names their hub subject; ACCESS_TOKEN stays operator access to 'main' only).
import { MAIN_OBJECT, forwardedRequest, signPersonSession, signSignupState, verifyPersonSession, verifySignupState } from './view-links.mjs';
import { beginSignIn, completeSignIn, oidcSettings } from './oidc.mjs';
import { normalizePhone, phoneOfWhatsAppId, startCode } from './registry.mjs';
import { whatsAppAdapter, whatsAppSettings } from './whatsapp.mjs';

export const SESSION_COOKIE = 'boring_session';
const SIGNIN_COOKIE = 'boring_signin';
const SESSION_DAYS = 30;
const SIGNIN_SECONDS = 600;
const FORM_LIMIT = 2048;
const WEBHOOK_LIMIT = 1_048_576;
/** Daily turns of a person's agent (the owner's 'main' has none). */
export const DEFAULT_DAILY_TURNS = 50;

const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Whether this deployment accepts signups at all (configured), and whether it is open now (SIGNUP_OPEN=1). */
export function signupSettings(env, origin) {
  const oidc = oidcSettings(env, origin);
  const number = String(env.WHATSAPP_PUBLIC_NUMBER ?? '').replace(/\D/g, '');
  if (!oidc || !number || !env.ACCESS_TOKEN || !env.REGISTRY) return undefined;
  return { oidc, number, open: env.SIGNUP_OPEN === '1', defaultCountry: env.SIGNUP_DEFAULT_COUNTRY || '41' };
}

/** A person's object: 'main' for the owner's hub subject (OWNER_SUBJECT), otherwise `p-` and 32 hex digits of SHA-256(issuer, subject). */
export async function personObject(env, issuer, subject) {
  if (env.OWNER_SUBJECT && subject === env.OWNER_SUBJECT) return MAIN_OBJECT;
  return `p-${hex(await crypto.subtle.digest('SHA-256', encoder.encode(`${issuer}\n${subject}`))).slice(0, 32)}`;
}

/** The daily turn cap of a person's object (SIGNUP_DAILY_TURNS, default 50). */
export const dailyTurns = env => Number(env.SIGNUP_DAILY_TURNS) > 0 ? Math.floor(Number(env.SIGNUP_DAILY_TURNS)) : DEFAULT_DAILY_TURNS;

function cookie(request, name) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}
const setCookie = (url, name, value, { maxAge, path = '/' }) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;

/** The signed-in person of a request (`{ object, sub, exp }` from the session cookie), or undefined. */
export async function personSession(request, env) {
  const token = cookie(request, SESSION_COOKIE);
  return token && env.ACCESS_TOKEN ? verifyPersonSession(env.ACCESS_TOKEN, token) : undefined;
}

/**
 * Whether a session's person may use their agent: the owner, or someone whose START was redeemed (registry membership). Before that,
 * a session is onboarding only (the code page): proving the phone number is what gives access to the agent, its model and services.
 */
export async function isMember(env, object) {
  return object === MAIN_OBJECT || (env.REGISTRY ? await env.REGISTRY.getByName('registry').member(object) : false);
}

// ---- Pages: plain HTML and CSS, phone first, light and dark, no script the page depends on (nothing secure-context-only). ----

const STYLE = `:root{color-scheme:light dark;--bg:#f7f7f4;--card:#fff;--fg:#17201b;--muted:#5b6660;--line:#dde3df;--accent:#147a4b;--accent-fg:#fff;--error:#a12d2d}
@media (prefers-color-scheme:dark){:root{--bg:#0f1311;--card:#171d1a;--fg:#e6ece9;--muted:#9aa7a1;--line:#2a332f;--accent:#2fbf7c;--accent-fg:#06140d;--error:#ff8a80}}
*{box-sizing:border-box}html,body{margin:0}body{min-height:100vh;background:var(--bg);color:var(--fg);font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 22px}
h1{font-size:26px;line-height:1.2;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}label{display:block;font-weight:600;margin:0 0 6px}
input{width:100%;font:inherit;font-size:20px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg)}
button,.button{display:block;width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}
.code{font:700 34px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.18em;text-align:center;padding:14px;border:1px dashed var(--line);border-radius:12px;margin:8px 0 16px;color:var(--fg)}
.error{color:var(--error)}.small{font-size:14px}a{color:inherit}`;

function page(title, body, { status = 200, headers = {}, script = '' } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', ...headers } });
}

// The landing page also opens the web app in place for an operator (`/#token=...`), a tab that already holds a token, or a view
// link's renewal: those never had a cookie, and the app reads them itself.
const BOOT_APP = `(function(){var has=function(k){try{return !!sessionStorage.getItem(k)}catch(e){return false}};
if(/(^#|&)token=/.test(location.hash)||location.hash==='#operator'||has('recipe.token')||has('recipe.link')){
if(location.hash==='#operator')history.replaceState(null,'',location.pathname);document.body.innerHTML='<div id="root"></div>';document.body.removeAttribute('style');
var l=document.createElement('link');l.rel='stylesheet';l.href='/styles.css';document.head.appendChild(l);document.querySelector('style').remove();
var s=document.createElement('script');s.type='module';s.src='/app.js';document.body.appendChild(s);}})();`;

// Returning people sign in without enrolling again (no phone, no code): this stays open when sign-ups are closed.
const SIGN_IN = `<form method="post" action="/signup" data-testid="signin-form" style="margin-top:12px"><input type="hidden" name="mode" value="login">
<button type="submit" data-testid="signin-submit" style="background:transparent;color:var(--fg);border:1px solid var(--line)">Already have your agent? Sign in</button></form>`;

export function landingPage(settings, { error, phone } = {}) {
  if (!settings.open) return page('Your agent on WhatsApp', `<h1>Your own agent on WhatsApp</h1><p>Sign-ups are closed right now. Please come back later.</p>${SIGN_IN}
${error ? `<p class="error small" role="alert" data-testid="signup-error">${escape(error)}</p>` : ''}`, { status: error ? 400 : 200, script: BOOT_APP });
  return page('Your agent on WhatsApp', `<h1>Your own agent on WhatsApp</h1>
<p>Enter your WhatsApp number, sign in, and send one message to start.</p>
<form method="post" action="/signup" data-testid="signup-form">
<label for="phone">WhatsApp number</label>
<input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+41 79 123 45 67" required maxlength="24" value="${escape(phone ?? '')}" data-testid="signup-phone">
${error ? `<p class="error small" role="alert" data-testid="signup-error">${escape(error)}</p>` : ''}
<button type="submit" data-testid="signup-submit">Get my agent</button>
</form>
${SIGN_IN}
<p class="small" style="margin-top:16px">Your number is used only to talk to your agent. <a href="/#operator">Operator access</a></p>`, { status: error ? 400 : 200, script: BOOT_APP });
}

function messagePage(title, text, status = 400) {
  return page(title, `<h1>${escape(title)}</h1><p>${escape(text)}</p><a class="button" href="/">Back</a>`, { status });
}

/** After sign-in: the code, the wa.me link (opened at once on a phone) and the same for a desktop to copy by hand. */
function startPage(settings, { code, phone }) {
  const link = `https://wa.me/${settings.number}?text=${encodeURIComponent(`START ${code}`)}`;
  return page('Send your code on WhatsApp', `<h1>One last step</h1>
<p>Send this message on WhatsApp from <strong>${escape(phone)}</strong>. The code works once, for 10 minutes.</p>
<div class="code" data-testid="signup-code">START ${escape(code)}</div>
<a class="button" href="${escape(link)}" data-testid="signup-whatsapp">Open WhatsApp</a>
<p class="small" style="margin-top:16px">On a computer: open WhatsApp on your phone and send <strong>START ${escape(code)}</strong> to <strong>+${escape(settings.number)}</strong>. Then <a href="/">open your agent on the web</a>.</p>`,
  // On a phone the WhatsApp app opens with the message ready; the page stays behind for "back".
  { script: `if(window.matchMedia&&window.matchMedia('(pointer:coarse)').matches)setTimeout(function(){location.href=${JSON.stringify(link)}},400);` });
}

/** `POST /signup`: the claimed number, then the hub's sign-in. */
export async function startSignup(request, env, settings) {
  const url = new URL(request.url);
  // Unauthenticated: the form is read under FORM_LIMIT bytes as it streams, and the rest is cancelled.
  const bytes = await readCapped(request, FORM_LIMIT);
  if (!bytes) return messagePage('Request too large', 'Please try again.', 413);
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  // `mode=login`: a returning person signs in again (allowed when sign-ups are closed); otherwise a new enrollment with a number.
  const login = form.get('mode') === 'login';
  let phone;
  if (!login) {
    if (!settings.open) return landingPage(settings);
    const raw = form.get('phone') ?? '';
    phone = normalizePhone(raw, settings.defaultCountry);
    if (!phone) return landingPage(settings, { error: 'That does not look like a phone number. Use the international form, e.g. +41 79 123 45 67.', phone: raw.slice(0, 24) });
  }
  let begun;
  try { begun = await beginSignIn(settings.oidc); } catch (error) { console.warn('signup: the hub is unavailable', String(error?.message ?? error).slice(0, 200)); return messagePage('Sign-in unavailable', 'The sign-in service could not be reached. Please try again in a minute.', 503); }
  const state = await signSignupState(env.ACCESS_TOKEN, { state: begun.state, nonce: begun.nonce, verifier: begun.verifier, ...(login ? { login: true } : { phone }) }, SIGNIN_SECONDS);
  return new Response(null, { status: 303, headers: { location: begun.url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'set-cookie': setCookie(url, SIGNIN_COOKIE, state, { maxAge: SIGNIN_SECONDS, path: '/auth' }) } });
}

/** `GET /auth/callback`: verify, set the person's session, issue the one-time code. */
export async function finishSignup(request, env, settings) {
  const url = new URL(request.url);
  const clear = setCookie(url, SIGNIN_COOKIE, '', { maxAge: 0, path: '/auth' });
  const failed = (reason, text = 'The sign-in did not complete. Please start again.') => { console.warn(`signup: ${reason}`); const response = messagePage('Sign-in failed', text); response.headers.append('set-cookie', clear); return response; };
  const pending = await verifySignupState(env.ACCESS_TOKEN, cookie(request, SIGNIN_COOKIE));
  const state = url.searchParams.get('state'), code = url.searchParams.get('code');
  if (!pending || !state || state !== pending.state) return failed('state missing or not matching');
  if (url.searchParams.get('error') || !code) return failed(`hub answered ${String(url.searchParams.get('error') ?? 'without a code').slice(0, 40)}`);
  let signedIn;
  try { signedIn = await completeSignIn(settings.oidc, { code, nonce: pending.nonce, verifier: pending.verifier }); }
  catch (error) { return failed(String(error?.message ?? error).slice(0, 200)); }
  const { claims } = signedIn;
  if (claims.email_verified === false) return failed('email not verified', 'Your email address is not verified yet.');
  const object = await personObject(env, settings.oidc.issuer, claims.sub);
  const person = { object, subject: claims.sub, ...(typeof claims.email === 'string' ? { email: claims.email } : {}) };
  const session = await signPersonSession(env.ACCESS_TOKEN, { object, subject: claims.sub }, SESSION_DAYS * 86_400);
  const signedInCookie = setCookie(url, SESSION_COOKIE, session, { maxAge: SESSION_DAYS * 86_400 });
  // A returning person (the owner, or someone the registry knows) gets their session back, also when sign-ups are closed. Closed
  // sign-ups refuse only new people and new number links.
  const member = object === MAIN_OBJECT || await env.REGISTRY.getByName('registry').member(object);
  if (pending.login || !settings.open) {
    if (!member) return failed(`${pending.login ? 'sign-in' : 'enrollment'} of an unknown person${settings.open ? '' : ' while closed'}`,
      settings.open ? 'There is no agent for this account yet: sign up with your WhatsApp number first.' : 'Sign-ups are closed right now.');
    return new Response(null, { status: 303, headers: [['location', '/'], ['cache-control', 'no-store'], ['set-cookie', clear], ['set-cookie', signedInCookie]] });
  }
  // The hub grant goes to the person's own object (for the hub link after START, refreshed there when needed); the registry gets none.
  if (signedIn.accessToken) await env.ASSISTANT.getByName(object).holdHubGrant({ subject: claims.sub, accessToken: signedIn.accessToken, accessExpires: signedIn.accessExpires,
    ...(signedIn.refreshToken ? { refreshToken: signedIn.refreshToken } : {}), resource: settings.oidc.resource });
  const issued = await env.REGISTRY.getByName('registry').issue({ person, phone: pending.phone });
  const response = startPage(settings, { code: issued.code, phone: pending.phone });
  response.headers.append('set-cookie', clear);
  response.headers.append('set-cookie', signedInCookie);
  return response;
}

/** `GET /signout`: the session cookie removed. */
export function signOut(request) {
  return new Response(null, { status: 303, headers: { location: '/', 'cache-control': 'no-store', 'set-cookie': setCookie(new URL(request.url), SESSION_COOKIE, '', { maxAge: 0 }) } });
}

/** `GET /.well-known/boring.json`: the app's manifest for the hub registry. */
export function manifest(env) {
  return Response.json({ protocol: 1, name: env.APP_NAME || 'boring-whatsapp-agent', version: env.APP_VERSION || '0.1.0', title: env.APP_TITLE || 'Agent on WhatsApp',
    description: env.APP_DESCRIPTION || 'Personal AI agent on WhatsApp.', agents: [], jobs: [], conversations: [], tools: [], endpoints: {} },
  { headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
}

/** The body under `limit` bytes, read as it streams; undefined (and the rest cancelled) past the limit, declared or not. */
async function readCapped(request, limit) {
  if (Number(request.headers.get('content-length') ?? 0) > limit) { if (request.body) void request.body.cancel().catch(() => {}); return undefined; }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

/**
 * The part of a verified Meta payload addressed to one object: only the messages whose ids are in `ids` (their contacts too, no
 * statuses), re-signed with the app secret exactly as Meta signs, so the object's own (unchanged) signature check passes and it never
 * sees another person's message.
 */
async function envelopeFor(payload, ids, appSecret) {
  const narrowed = { ...payload, entry: (payload.entry ?? []).map(entry => ({ ...entry, changes: (entry.changes ?? []).map(change => {
    const value = change.value ?? {};
    const messages = (value.messages ?? []).filter(message => ids.has(message.id));
    const senders = new Set(messages.map(message => message.from));
    const { statuses: _statuses, ...rest } = value;
    return { ...change, value: { ...rest, messages, ...(value.contacts ? { contacts: value.contacts.filter(contact => senders.has(contact.wa_id)) } : {}) } };
  }).filter(change => change.value.messages.length) })).filter(entry => entry.changes.length) };
  const body = encoder.encode(JSON.stringify(narrowed));
  const key = await crypto.subtle.importKey('raw', encoder.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { body, signature: `sha256=${hex(await crypto.subtle.sign('HMAC', key, body))}` };
}

/**
 * `POST /whatsapp` with signup on: the Worker verifies Meta's signature (the same adapter the objects use), handles `START <code>`
 * itself, and gives each object only its own senders' messages: the owner's allow-list to 'main', a linked number to the person who
 * owns it in the registry. A mixed batch is split per object (re-signed, see envelopeFor). An unknown number is told where to sign up
 * (once a day). Each object also checks the registry itself before admitting a message or sending a scheduled reply.
 */
export async function routeWhatsApp(request, env, settings) {
  const whatsapp = whatsAppSettings(env);
  const main = () => env.ASSISTANT.getByName(MAIN_OBJECT);
  if (!whatsapp || request.method !== 'POST') return main().fetch(forwardedRequest(request));
  const body = await readCapped(request, WEBHOOK_LIMIT);
  if (!body) return new Response('payload too large', { status: 413 });
  const adapter = whatsAppAdapter(whatsapp);
  const receipt = await adapter.receive(new Request(request.url, { method: 'POST', headers: request.headers, body }));
  if (receipt.kind === 'response') return receipt.response;
  const origin = new URL(request.url).origin, registry = env.REGISTRY.getByName('registry');
  const say = (address, text) => adapter.send(address, { kind: 'notice', text }).catch(error => console.warn('signup reply failed', String(error?.message ?? error).slice(0, 200)));
  /** Object name → the ids of the messages it gets. */
  const targets = new Map();
  const route = (name, message) => { if (!targets.has(name)) targets.set(name, new Set()); targets.get(name).add(message.messageId); };
  for (const message of receipt.messages) {
    const phone = phoneOfWhatsAppId(message.address);
    const code = startCode(message.text);
    const ownerNumber = whatsapp.allowed.includes(message.address);
    if (code && phone) {
      // A redelivered START whose redemption was committed: completed whatever happened since (sign-ups closed, code cleaned up).
      let result = await registry.replay({ messageId: message.messageId, phone });
      if (!result) {
        if (!settings.open) { await say(message.address, `Sign-ups are closed right now. Please try again later: ${origin}`); continue; }
        result = await registry.redeem({ code, phone, messageId: message.messageId, ownerNumber });
      }
      if (result.status !== 'linked') {
        await say(message.address, result.reason === 'owned' ? 'This number is already linked to another account. Please contact the operator to move it.'
          : `That code is not valid or has expired. Get a new one at ${origin}`);
        continue;
      }
      // Debug-only: the Worker dies between the redemption and the adoption (the registry's alarm, or Meta's redelivery, completes it).
      if (env.ENABLE_DEBUG_ROUTES === '1' && await registry.take('after-redeem')) throw new Error('crashpoint after-redeem');
      // Thrown: the webhook is not acknowledged and Meta delivers it again; the registry's alarm also retries the adoption.
      await env.ASSISTANT.getByName(result.person.object).adopt({ phone, subject: result.person.subject });
      await registry.adopted({ object: result.person.object, phone });
      // Also on a redelivery: the earlier attempt may have failed before this reply (a redelivery only follows a failure).
      await say(message.address, "You're set up! This is your own agent: write here anytime. Your web workspace: " + origin);
      continue;
    }
    if (ownerNumber) { route(MAIN_OBJECT, message); continue; }
    const person = phone ? await registry.phone(phone) : undefined;
    if (person) { route(person.object, message); continue; }
    if (phone && settings.open && await registry.nudge(phone)) await say(message.address, `Hi! To get your own agent, sign up at ${origin}`);
  }
  let accepted = 0;
  const payload = targets.size ? JSON.parse(new TextDecoder().decode(body)) : undefined;
  for (const [name, ids] of targets) {
    const part = await envelopeFor(payload, ids, whatsapp.credentials.appSecret);
    const headers = new Headers(request.headers);
    headers.set('x-hub-signature-256', part.signature);
    headers.delete('content-length');
    const response = await env.ASSISTANT.getByName(name).fetch(forwardedRequest(new Request(request.url, { method: 'POST', headers, body: part.body })));
    // Not acknowledged: Meta delivers the webhook again (every step above is idempotent per message).
    if (!response.ok) return response;
    accepted += Number((await response.json().catch(() => ({})))?.accepted ?? 0);
  }
  return Response.json({ schema: 'boring.channels', version: 1, accepted }, { headers: { 'cache-control': 'no-store' } });
}
