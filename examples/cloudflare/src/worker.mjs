// The Worker: authentication, then each request goes to the Durable Object it belongs to. Static files are served by the assets
// binding without running this code (except `/`, which is the signup landing page when signup is configured, see signup.mjs).
//
// One object per person (`getByName(<person id>)`); the owner's is 'main'. Who may reach what:
// - ACCESS_TOKEN (bearer): the operator, 'main' only, the debug routes included.
// - a person's session cookie (after signing in through the hub): their own object, never the debug routes; a write must come from
//   this origin (Origin header), the cookie being SameSite=Lax as well.
// - a view link's session (bearer, see view-links.mjs): the object that made the link, and in it only the link's conversation (the
//   object enforces that from the access the Worker forwards).
// Tokens are never logged.
import { MAIN_OBJECT, VIEW_PATH, forwardedRequest, notFound, objectOf, sessionLink, verifySession, verifyViewLink } from './view-links.mjs';
import { MCP_CALLBACK_PATH } from './mcp.mjs';
import { finishSignup, isMember, landingPage, manifest, personSession, routeWhatsApp, signOut, signupSettings, startSignup } from './signup.mjs';

export { Assistant } from './assistant.mjs';
export { Registry } from './registry.mjs';

const encoder = new TextEncoder();
const PRIVATE = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * `{ scope: 'operator', object: 'main' }` for the Worker secret (constant-time comparison of SHA-256 digests), `{ scope: 'link', object,
 * conversation, expires }` for a valid view-link session, `{ scope: 'person', object, expires }` for a signed-in person's cookie, else undefined.
 */
async function authenticate(request, env) {
  if (!env.ACCESS_TOKEN) return undefined;
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (presented) {
    const [a, b] = await Promise.all([presented, env.ACCESS_TOKEN].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
    if (crypto.subtle.timingSafeEqual(a, b)) return { scope: 'operator', object: MAIN_OBJECT };
    const session = await verifySession(env.ACCESS_TOKEN, presented);
    return session ? { scope: 'link', object: objectOf(session), conversation: session.conversation, expires: session.exp } : undefined;
  }
  const person = await personSession(request, env);
  if (!person) return undefined;
  // A cookie rides along on cross-site requests too: a write is accepted only from this origin.
  if (UNSAFE.has(request.method) && request.headers.get('origin') !== new URL(request.url).origin) return undefined;
  // Before the person's START was redeemed the session is onboarding only: no agent, no model, no services.
  if (!await isMember(env, person.object)) return { scope: 'onboarding' };
  return { scope: 'person', object: person.object, expires: person.exp };
}

const refused = () => Response.json({ reason: 'authentication-required' }, { status: 401, headers: { 'www-authenticate': 'Bearer', 'cache-control': 'no-store' } });

async function appPage(env, url) {
  const page = await env.ASSETS.fetch(new Request(new URL('/', url), { headers: { accept: 'text/html' } }));
  return new Response(page.body, { status: page.status, headers: { 'content-type': page.headers.get('content-type') ?? 'text/html; charset=utf-8', ...PRIVATE } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const object = name => env.ASSISTANT.getByName(name);
    const signup = signupSettings(env, url.origin);
    if (url.pathname === '/.well-known/boring.json' && request.method === 'GET') return manifest(env);
    if (signup) {
      if ((url.pathname === '/' || url.pathname === '/index.html') && request.method === 'GET') {
        const person = await personSession(request, env);
        return person && await isMember(env, person.object) ? appPage(env, url) : landingPage(signup);
      }
      if (url.pathname === '/signup' && request.method === 'POST') return startSignup(request, env, signup);
      if (url.pathname === '/auth/callback' && request.method === 'GET') return finishSignup(request, env, signup);
      if (url.pathname === '/signout' && request.method === 'GET') return signOut(request);
      // Meta's webhook, authenticated by its signature: START codes here, every other message to its sender's own object.
      if (url.pathname === '/whatsapp') return routeWhatsApp(request, env, signup);
    }
    // Without signup: one owner, as before. The webhook is checked by its signature in the object.
    if (url.pathname === '/whatsapp') return object(MAIN_OBJECT).fetch(forwardedRequest(request));
    if (url.pathname.startsWith(VIEW_PATH) && request.method === 'GET') {
      // A link names the object that made it; an invalid one reaches no object.
      const target = await verifyViewLink(env.ACCESS_TOKEN, url.pathname.slice(VIEW_PATH.length));
      if (!target) return notFound();
      // The read-only preview of the linked thing, sandboxed, rendered by its object.
      if (url.searchParams.get('raw') === '1') return object(objectOf(target)).fetch(forwardedRequest(request));
      // A valid link opens the web app, which exchanges the link for a session. The page itself holds no data.
      return appPage(env, url);
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // MCP OAuth redirect from the provider: no bearer (a browser follows it); the owner's MCP manager checks the state it issued.
    if (url.pathname === MCP_CALLBACK_PATH && request.method === 'GET') return object(MAIN_OBJECT).fetch(forwardedRequest(request));
    // The link itself is the credential for the exchange: read (under the cap) to find its object, which checks it again.
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const { link, status } = await sessionLink(request);
      if (status) return Response.json({ reason: status === 413 ? 'too-large' : status === 415 ? 'unsupported-media-type' : 'invalid-request' }, { status, headers: { 'cache-control': 'no-store' } });
      const target = typeof link === 'string' ? await verifyViewLink(env.ACCESS_TOKEN, link) : undefined;
      if (!target) return Response.json({ reason: 'link-invalid' }, { status: 401, headers: { 'cache-control': 'no-store' } });
      return object(objectOf(target)).fetch(forwardedRequest(new Request(request.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link }) })));
    }
    const who = await authenticate(request, env);
    if (!who) return refused();
    if (who.scope === 'onboarding') return Response.json({ reason: 'phone-not-linked', message: 'Send your START code on WhatsApp first.' }, { status: 403, headers: { 'cache-control': 'no-store' } });
    // Proof routes are for the operator's own token only.
    if (who.scope !== 'operator' && url.pathname.startsWith('/api/debug/')) return refused();
    // With ENABLE_DEBUG_ROUTES=1 only (a journey): a one-shot crash point in the Worker's own START handling (kept by the registry).
    if (url.pathname === '/api/debug/registry-crashpoint' && request.method === 'POST' && env.ENABLE_DEBUG_ROUTES === '1' && env.REGISTRY) {
      await env.REGISTRY.getByName('registry').arm(String((await request.json().catch(() => ({})))?.name ?? ''));
      return Response.json({ armed: true });
    }
    // With ENABLE_DEBUG_ROUTES=1 only (a journey), the operator may aim a proof route at a person's object (`?object=`).
    if (url.pathname.startsWith('/api/debug/') && env.ENABLE_DEBUG_ROUTES === '1' && url.searchParams.get('object')) {
      return object(url.searchParams.get('object')).fetch(forwardedRequest(request, undefined, { scope: 'operator' }));
    }
    // The object trusts these headers only from here: a client's copies are always removed.
    return object(who.object).fetch(forwardedRequest(request, who.expires, { scope: who.scope, ...(who.scope === 'link' ? { conversation: who.conversation ?? '' } : {}) }));
  },
};
