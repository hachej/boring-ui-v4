// View links for things the agent made: an artifact, a workspace file or the shared document. A link is `/v/<payload>.<signature>`,
// signed with a key derived from the Worker secret ACCESS_TOKEN and expiring (7 days by default), so it can be sent in a WhatsApp
// message without giving away the page's bearer token. It names one thing and the conversation it was made in.
//
// Opening a link opens the web workspace on that conversation with the thing open in its editor: the page exchanges the link for a
// session (`POST /api/session`), a short-lived bearer token (24 hours, scope `link`) signed with a different derived key, so a link
// is never a session and a session is never a link. Both name the agent's object (one per person, see signup.mjs; a link made before
// objects were named belongs to 'main'), and a link session reaches only that object and only the link's conversation. `/v/<link>?raw=1` still renders the thing read-only (see `renderView`): the
// response at the link's URL is a fixed, script-free page, and the thing itself runs only inside a sandboxed `srcdoc` frame that
// cannot see the link, the session or this origin's storage, nor navigate the top window. Markdown, code and SVG never run scripts.
import { marked } from 'marked';
import { guardStatus, readJsonBody } from '@boring/files/request-guard';
import { SCRIPT_SOURCES } from '../../studio/interactive.mjs';

export const VIEW_PATH = '/v/';
export const DAY = 86_400;
/** The largest `POST /api/session` body (`{ link }`). The route has no bearer token, so its body is read under this cap. */
export const SESSION_BODY_LIMIT = 4096;

/**
 * The `link` of a `POST /api/session` body, or `{ status }` when the body is refused: a JSON content type is required and the
 * body is streamed under SESSION_BODY_LIMIT, so an oversized body (declared or not) is refused once the cap is passed and the
 * rest of its stream is cancelled, never buffered.
 */
export async function sessionLink(request) {
  let body;
  try { body = await readJsonBody(request, SESSION_BODY_LIMIT); } catch (error) {
    if (request.body && !request.bodyUsed) void request.body.cancel().catch(() => {});
    return { status: guardStatus(error) };
  }
  return { link: typeof body?.link === 'string' ? body.link : undefined };
}
const encoder = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
const LINKS = 'boring.view-links.v1', SESSIONS = 'boring.sessions.v1', PEOPLE = 'boring.person-sessions.v1', SIGNUP = 'boring.signup-state.v1';

const keys = new Map();
function key(secret, purpose) {
  const id = `${purpose}:${secret}`;
  if (!keys.has(id)) keys.set(id, crypto.subtle.digest('SHA-256', encoder.encode(id))
    .then(material => crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])));
  return keys.get(id);
}

async function sign(secret, purpose, body, ttlSeconds) {
  const payload = b64url(encoder.encode(JSON.stringify({ ...body, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret, purpose), encoder.encode(payload)));
  return `${payload}.${b64url(signature)}`;
}

/** The signed body when the signature is valid (HMAC verify, constant time) and it has not expired; otherwise undefined. */
async function verify(secret, purpose, token) {
  if (!secret) return undefined;
  const [payload, signature, extra] = String(token ?? '').split('.');
  if (!payload || !signature || extra !== undefined || payload.length > 2048) return undefined;
  let valid = false;
  try { valid = await crypto.subtle.verify('HMAC', await key(secret, purpose), unb64url(signature), encoder.encode(payload)); } catch { return undefined; }
  if (!valid) return undefined;
  try {
    const body = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (typeof body?.exp !== 'number' || body.exp <= Date.now() / 1000) return undefined;
    return body;
  } catch { return undefined; }
}

/** @param {({ kind: 'artifact', id: string } | { kind: 'file', path: string } | { kind: 'notes' }) & { conversation?: string }} target */
export const signViewLink = (secret, target, ttlSeconds = 7 * DAY) => sign(secret, LINKS, target, ttlSeconds);
/**
 * The same token (or a URL ending in one) with its signature changed, for the journeys' refusal checks. The first signature
 * character carries six whole bits of the first byte, so the decoded signature always differs; the last one may be padding only.
 */
export function tamperedSignature(token) {
  const at = token.lastIndexOf('.') + 1;
  return `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;
}
/** The target of a valid, unexpired link, or undefined. */
export const verifyViewLink = (secret, token) => verify(secret, LINKS, token);

/** The object a link or session belongs to: the one it names, or 'main' for one made before objects were named. */
export const MAIN_OBJECT = 'main';
export const objectOf = signed => typeof signed?.object === 'string' && signed.object ? signed.object : MAIN_OBJECT;

/** A link session token: one object, the conversation the link named, at most 24 hours. */
export const signSession = (secret, { conversation, object = MAIN_OBJECT }, ttlSeconds = DAY) =>
  sign(secret, SESSIONS, { scope: 'link', object, ...(conversation === undefined ? {} : { conversation: String(conversation) }) }, Math.min(ttlSeconds, DAY));
/** The session of a valid, unexpired link session token (scope `owner` is the same token issued before scopes were narrowed), or undefined. */
export async function verifySession(secret, token) { const session = await verify(secret, SESSIONS, token); return session?.scope === 'link' || session?.scope === 'owner' ? session : undefined; }

/** A person's web session after signing in through the hub (the cookie, see signup.mjs): their object only, never the debug routes. */
export const signPersonSession = (secret, { object, subject }, ttlSeconds) => sign(secret, PEOPLE, { scope: 'person', object, sub: subject }, ttlSeconds);
export async function verifyPersonSession(secret, token) { const session = await verify(secret, PEOPLE, token); return session?.scope === 'person' && typeof session.object === 'string' ? session : undefined; }
/** The short-lived signed state of one sign-in in progress (state, nonce, PKCE verifier, claimed phone), kept in a cookie. */
export const signSignupState = (secret, state, ttlSeconds) => sign(secret, SIGNUP, state, ttlSeconds);
export const verifySignupState = (secret, token) => verify(secret, SIGNUP, token);

/**
 * The verified expiry of a session-authenticated request, as the Worker forwards it to the object (seconds since the epoch). The
 * Worker removes any copy the client sent, so only the Worker's own verification reaches the object.
 */
export const SESSION_EXPIRES_HEADER = 'x-boring-session-expires';

/**
 * Who the Worker verified, forwarded the same way: `operator` (ACCESS_TOKEN), `person` (a signed-in person's session) or `link` (a view
 * link's session, with the conversation it may reach). Absent on the routes the Worker forwards unauthenticated (webhook, link exchange,
 * OAuth callback, preview), which the object answers before it looks at access.
 */
export const ACCESS_HEADER = 'x-boring-access', CONVERSATION_HEADER = 'x-boring-conversation';
const TRUSTED = [SESSION_EXPIRES_HEADER, ACCESS_HEADER, CONVERSATION_HEADER];

/**
 * The request the Worker forwards: every client-supplied copy of the trusted headers removed, then the verified `exp` of a session
 * token and the verified access (`{ scope, conversation? }`) when given.
 */
export function forwardedRequest(request, sessionExpires, access) {
  const headers = new Headers(request.headers);
  for (const name of TRUSTED) headers.delete(name);
  if (sessionExpires !== undefined) headers.set(SESSION_EXPIRES_HEADER, String(sessionExpires));
  if (access?.scope) headers.set(ACCESS_HEADER, access.scope);
  if (access?.conversation !== undefined) headers.set(CONVERSATION_HEADER, String(access.conversation));
  return new Request(request, { headers });
}

/** The access the Worker forwarded: `{ scope: 'operator' | 'person' | 'link' | 'none', conversation? }`. */
export function forwardedAccess(request) {
  const scope = request.headers.get(ACCESS_HEADER);
  const conversation = request.headers.get(CONVERSATION_HEADER);
  return { scope: ['operator', 'person', 'link'].includes(scope) ? scope : 'none', ...(conversation === null ? {} : { conversation }) };
}

/** Fires when the forwarded session expires (already aborted when it has), so an open chat watch ends then; undefined for the owner's token. */
export function sessionRevocation(request) {
  const value = request.headers.get(SESSION_EXPIRES_HEADER);
  if (value === null) return undefined;
  const remaining = Number(value) * 1000 - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return AbortSignal.abort(new Error('session expired'));
  return AbortSignal.timeout(Math.min(remaining, 2 ** 31 - 1));
}

const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const headers = csp => ({ 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' });
const PAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:";
const STYLE = `:root{color-scheme:light dark;--bg:#fbfbf9;--fg:#1b1f1d;--muted:#5f6b66;--line:#dde3df;--code:#f0f2ef}
@media (prefers-color-scheme:dark){:root{--bg:#121614;--fg:#e4eae7;--muted:#9aa7a1;--line:#2b3430;--code:#1b2220}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}
main{max-width:720px;margin:0 auto;padding:28px 18px 64px}header{color:var(--muted);font-size:13px;border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:18px}
</style></head><body><main><header>${escape(title)} · read-only preview</header>${body}</main></body></html>`;
}

// Generated content never runs at a link's URL. The URL carries the credential (POST /api/session turns it into an owner session),
// so the response there is a fixed page with no script of its own: a header and one sandboxed frame whose `srcdoc` holds the item,
// escaped into an attribute. The frame's document is `about:srcdoc` on an opaque origin with no referrer (the wrapper's
// `referrer-policy: no-referrer`), cannot reach this page, its storage or its address, and cannot navigate the top window, open
// windows or submit forms (sandbox: at most `allow-scripts`, never allow-same-origin / allow-top-navigation / allow-popups).
// A srcdoc document inherits the wrapper's Content-Security-Policy, so the wrapper's policy is the one the item runs under: an
// HTML item gets inline script and style plus the two library CDNs (the studio's interactive preview rule, examples/studio/
// interactive.mjs), every other item no script at all. `frame-src 'none'` also stops the frame navigating itself anywhere.
const CDNS = SCRIPT_SOURCES.join(' ');
const FRAME_CSP = {
  scripts: `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${CDNS}; style-src 'unsafe-inline' ${CDNS}; img-src data: blob:; font-src data: ${CDNS}; connect-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'`,
  static: "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'",
};

function framed(title, inner, { scripts }) {
  const sandbox = scripts ? 'allow-scripts' : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}
body{display:flex;flex-direction:column;height:100vh}header{color:var(--muted);font-size:13px;border-bottom:1px solid var(--line);padding:8px 18px}iframe{flex:1;width:100%;border:0;background:#fff}
</style></head><body><header>${escape(title)} · read-only preview</header><iframe title="${escape(title)}" sandbox="${sandbox}" allow="" referrerpolicy="no-referrer" data-testid="view-frame" srcdoc="${escape(inner)}"></iframe></body></html>`;
  return new Response(html, { headers: { ...headers(scripts ? FRAME_CSP.scripts : FRAME_CSP.static), 'content-type': 'text/html; charset=utf-8' } });
}

const DOCUMENT_STYLE = `<style>${STYLE}
main{max-width:720px;margin:0 auto;padding:20px 18px 64px}h1,h2,h3{line-height:1.2}pre,code{font-family:ui-monospace,Menlo,monospace;font-size:14px;background:var(--code);border-radius:6px}pre{padding:12px;overflow-x:auto}code{padding:1px 4px}pre code{padding:0}
table{border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:6px 10px}img,svg{max-width:100%}a{color:inherit}</style>`;
const svgImage = text => `<img alt="" src="data:image/svg+xml,${encodeURIComponent(text)}">`;

/**
 * The response for one resolved item: always the fixed framing page above, never the item as the document at the link's URL.
 * @param {{ title: string, type: 'markdown' | 'html' | 'svg' | 'code' | 'text', text: string, language?: string }} item
 */
export function renderView(item) {
  if (item.type === 'html') return framed(item.title, `<!doctype html><meta name="referrer" content="no-referrer">${item.text}`, { scripts: true });
  const body = item.type === 'markdown' ? marked.parse(item.text, { async: false, gfm: true })
    : item.type === 'svg' ? svgImage(item.text) // an image never runs the SVG's scripts
    : `<pre><code${item.language ? ` data-language="${escape(item.language)}"` : ''}>${escape(item.text)}</code></pre>`;
  return framed(item.title, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">${DOCUMENT_STYLE}</head><body><main>${body}</main></body></html>`, { scripts: false });
}

/** How a workspace file is shown, by its extension. */
export function fileViewType(path) {
  const extension = path.toLowerCase().split('.').pop();
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'svg') return 'svg';
  return 'code';
}

export const notFound = () => new Response(page('Link not available', '<p>This link has expired or is not valid. Ask the agent for a new one.</p>'), { status: 404, headers: { ...headers(PAGE_CSP), 'content-type': 'text/html; charset=utf-8' } });
