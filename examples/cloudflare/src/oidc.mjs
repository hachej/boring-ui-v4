// Sign-in through the hub as an OpenID Connect client: authorization code + PKCE (S256), `state` and `nonce`, a confidential client
// (client_secret_basic). Endpoints come from the issuer's discovery document, never hard-coded; the id_token is verified here with Web
// Crypto against the issuer's JWKS (signature, `iss`, `aud`/`azp`, `exp`, `iat`, `nonce`). The access token is the hub's proof of the
// person for its app API (`POST /v1/app/whatsapp-identity`): it stays on the server, never in the browser.
//
// Configuration (Worker vars and secrets): HUB_ISSUER (exact `iss`, e.g. https://hub.example/api/auth), OIDC_CLIENT_ID and the secret
// OIDC_CLIENT_SECRET (HUB_CLIENT_ID / HUB_CLIENT_SECRET are accepted too), optional OIDC_REDIRECT_URI (default <origin>/auth/callback),
// optional HUB_RESOURCE (the token audience, default <origin>/api), optional OIDC_SCOPE.

const encoder = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
const random = bytes => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
// offline_access: a refresh token, so the hub link (hub.mjs) still succeeds when START arrives after the 15-minute access token expired.
const DEFAULT_SCOPE = 'openid email profile offline_access hub:whatsapp';
/** Seconds of clock skew allowed on `exp` and `iat`. */
const SKEW = 60;
const CACHE_MS = 10 * 60_000;

/** The OIDC settings of the Worker environment, or undefined when signup is not configured. */
export function oidcSettings(env, origin) {
  const issuer = env.HUB_ISSUER, clientId = env.OIDC_CLIENT_ID || env.HUB_CLIENT_ID, clientSecret = env.OIDC_CLIENT_SECRET || env.HUB_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) return undefined;
  return { issuer: issuer.replace(/\/$/, ''), clientId, clientSecret, redirectUri: env.OIDC_REDIRECT_URI || `${origin}/auth/callback`,
    resource: env.HUB_RESOURCE || `${origin}/api`, scope: env.OIDC_SCOPE || DEFAULT_SCOPE };
}

const cache = new Map();
async function cached(key, load, { fresh = false } = {}) {
  const hit = cache.get(key);
  if (!fresh && hit && hit.until > Date.now()) return hit.value;
  const value = await load();
  cache.set(key, { value, until: Date.now() + CACHE_MS });
  return value;
}

async function getJson(url, fetcher) {
  const response = await fetcher(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: ${response.status}`);
  return response.json();
}

/** The issuer's discovery document; its `issuer` must be exactly the configured one (OIDC Discovery §4.3). */
export function discover(settings, fetcher = fetch) {
  return cached(`discovery:${settings.issuer}`, async () => {
    const document = await getJson(`${settings.issuer}/.well-known/openid-configuration`, fetcher);
    if (document?.issuer !== settings.issuer) throw new Error('discovery issuer mismatch');
    for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (typeof document[name] !== 'string') throw new Error(`discovery: no ${name}`);
    return document;
  });
}

/** A new sign-in: the values kept (signed) in the browser's state cookie and the hub URL to send the browser to. */
export async function beginSignIn(settings, fetcher = fetch) {
  const discovery = await discover(settings, fetcher);
  const state = random(24), nonce = random(24), verifier = random(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
  const url = new URL(discovery.authorization_endpoint);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: settings.clientId, redirect_uri: settings.redirectUri, scope: settings.scope,
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', resource: settings.resource })) url.searchParams.set(key, value);
  return { url: url.href, state, nonce, verifier };
}

/**
 * The callback: the code exchanged at the token endpoint (client_secret_basic, the PKCE verifier, the resource) and the id_token
 * verified. Returns `{ claims, accessToken, accessExpires }`; throws on any mismatch.
 */
export async function completeSignIn(settings, { code, nonce, verifier }, fetcher = fetch) {
  const discovery = await discover(settings, fetcher);
  const tokens = await tokenRequest(settings, discovery, { grant_type: 'authorization_code', code, redirect_uri: settings.redirectUri, code_verifier: verifier, resource: settings.resource }, fetcher);
  if (typeof tokens?.id_token !== 'string') throw new Error('no id_token');
  const claims = await verifyIdToken(settings, tokens.id_token, nonce, discovery, fetcher);
  return { claims, ...grantOf(tokens) };
}

/** The server-side part of a token response: the access token, its expiry (seconds) and the refresh token when one was issued. */
const grantOf = tokens => ({ accessToken: typeof tokens.access_token === 'string' ? tokens.access_token : undefined,
  accessExpires: Math.floor(Date.now() / 1000) + (Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : 900),
  ...(typeof tokens.refresh_token === 'string' ? { refreshToken: tokens.refresh_token } : {}) });

/** One token endpoint call with client_secret_basic (RFC 6749 §2.3.1: id and secret form-encoded, then Basic). */
async function tokenRequest(settings, discovery, form, fetcher) {
  const basic = btoa(`${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`);
  const response = await fetcher(discovery.token_endpoint, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const after = Number(response.headers.get('retry-after'));
    throw Object.assign(new Error(`token endpoint: ${response.status}`), { status: response.status, code: typeof body?.error === 'string' ? body.error : undefined,
      ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {}) });
  }
  return response.json();
}

/**
 * A fresh access token for `resource` from a refresh token (same client authentication). Returns `{ accessToken, accessExpires,
 * refreshToken? }` (a rotated refresh token when the hub issues one); throws with `status` on a refusal.
 */
export async function refreshAccess(settings, { refreshToken, resource }, fetcher = fetch) {
  const discovery = await discover(settings, fetcher);
  return grantOf(await tokenRequest(settings, discovery, { grant_type: 'refresh_token', refresh_token: refreshToken, ...(resource ? { resource } : {}) }, fetcher));
}

const ALGORITHMS = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' }, kty: 'RSA' },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' }, kty: 'EC' },
  EdDSA: { import: { name: 'Ed25519' }, verify: { name: 'Ed25519' }, kty: 'OKP' },
};

async function keyFor(header, discovery, fetcher) {
  const pick = jwks => (jwks?.keys ?? []).find(key => (header.kid === undefined || key.kid === header.kid) && key.kty === ALGORITHMS[header.alg].kty && (key.alg === undefined || key.alg === header.alg) && (key.use === undefined || key.use === 'sig'));
  let jwk = pick(await cached(`jwks:${discovery.jwks_uri}`, () => getJson(discovery.jwks_uri, fetcher)));
  // An unknown key id: the issuer may have rotated its keys since they were cached.
  if (!jwk) jwk = pick(await cached(`jwks:${discovery.jwks_uri}`, () => getJson(discovery.jwks_uri, fetcher), { fresh: true }));
  if (!jwk) throw new Error('no matching signing key');
  const { kty, n, e, crv, x, y } = jwk;
  return crypto.subtle.importKey('jwk', { kty, n, e, crv, x, y }, ALGORITHMS[header.alg].import, false, ['verify']);
}

/** The verified claims of an id_token. */
export async function verifyIdToken(settings, token, nonce, discovery, fetcher = fetch) {
  const [head, body, signature, extra] = String(token).split('.');
  if (!head || !body || !signature || extra !== undefined) throw new Error('malformed id_token');
  const header = JSON.parse(new TextDecoder().decode(unb64url(head)));
  const allowed = discovery.id_token_signing_alg_values_supported ?? Object.keys(ALGORITHMS);
  if (!ALGORITHMS[header.alg] || !allowed.includes(header.alg)) throw new Error(`id_token algorithm ${String(header.alg).slice(0, 10)} not accepted`);
  const key = await keyFor(header, discovery, fetcher);
  if (!await crypto.subtle.verify(ALGORITHMS[header.alg].verify, key, unb64url(signature), encoder.encode(`${head}.${body}`))) throw new Error('id_token signature invalid');
  const claims = JSON.parse(new TextDecoder().decode(unb64url(body)));
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== settings.issuer) throw new Error('id_token issuer mismatch');
  if (!audience.includes(settings.clientId) || (audience.length > 1 && claims.azp !== settings.clientId)) throw new Error('id_token audience mismatch');
  if (claims.azp !== undefined && claims.azp !== settings.clientId) throw new Error('id_token azp mismatch');
  if (!(typeof claims.exp === 'number' && claims.exp + SKEW > now)) throw new Error('id_token expired');
  if (typeof claims.iat === 'number' && claims.iat - SKEW > now) throw new Error('id_token issued in the future');
  if (!nonce || claims.nonce !== nonce) throw new Error('id_token nonce mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token has no subject');
  return claims;
}
