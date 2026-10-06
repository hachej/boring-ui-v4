// Telling the hub which WhatsApp number a person linked: `POST <HUB_URL>/v1/app/whatsapp-identity { subjectToken, phone }` with the
// app's workload key (HUB_APP_KEY) as bearer and the person's own hub access token as proof (the hub takes the person from that
// token, never from the app). Best effort: the Worker's registry (registry.mjs) already routes the number and decides who may use the
// bot; linking does not make the person a member of the app in the hub. It runs as a Lifecycle job of the person's object, so a failed
// call is retried with a backoff even across a restart.
//
// The person's grant (access token, its expiry, the refresh token from `offline_access`) is kept in their own object only: never in the
// registry, never logged. The job refreshes the access token first when it has expired (or is about to), so a START sent after the
// 15-minute access-token lifetime still links. A refused refresh (revoked, expired) ends the attempt; the registry link stays.
import { LifecycleCapability } from 'agents/lifecycle';
import { oidcSettings, refreshAccess } from './oidc.mjs';

const GRANT = 'hub-grant', PENDING = 'hub-identity-pending', LINKED = 'hub-identity-linked';
const RETRY_MS = [15_000, 60_000, 180_000, 600_000];
/** The retry delays: RETRY_MS, or HUB_LINK_RETRY_MS (comma-separated milliseconds; local journeys only). */
const retries = env => { const custom = String(env.HUB_LINK_RETRY_MS ?? '').split(',').map(Number).filter(value => value > 0); return custom.length ? custom : RETRY_MS; };
/** Refresh an access token this many seconds before it expires. */
const MARGIN = 60;

/** The hub's origin: HUB_URL, or the origin of HUB_ISSUER. */
export const hubOrigin = env => env.HUB_URL ? env.HUB_URL.replace(/\/$/, '') : env.HUB_ISSUER ? new URL(env.HUB_ISSUER).origin : undefined;

export class HubIdentityLink extends LifecycleCapability {
  #env; #storage; #fetch; #crash;
  /** Conditional writes (compare the version, then write) run one at a time. */
  #queue = Promise.resolve();
  #serial(work) { const run = this.#queue.then(work); this.#queue = run.catch(() => undefined); return run; }

  /** @param {{ env: object, storage: DurableObjectStorage, fetcher?: typeof fetch, crash?: (name: string) => Promise<void> }} options (`crash`: debug-only crash points) */
  constructor({ env, storage, fetcher = (...args) => fetch(...args), crash = async () => {} }) {
    super('hub-identity');
    this.#env = env; this.#storage = storage; this.#fetch = fetcher; this.#crash = crash;
  }

  /** Keep the person's grant from their sign-in: `{ subject, accessToken, accessExpires, refreshToken?, resource }`, under a new version. */
  hold(grant) { return this.#serial(() => this.#storage.put(GRANT, { ...grant, version: crypto.randomUUID() })); }

  /**
   * The storage entries of the obligation to link `phone` (E.164) at the hub, for the caller to write in the SAME put as the phone
   * adoption (so an interrupted adoption never loses it); empty when the hub link is not configured or no grant is held.
   */
  async obligation(phone) {
    if (!this.#env.HUB_APP_KEY || !hubOrigin(this.#env) || !await this.#storage.get(GRANT)) { console.log('hub identity: not configured or no grant; the registry alone routes this number'); return {}; }
    return { [PENDING]: { phone, version: crypto.randomUUID(), attempts: 0 } };
  }

  /**
   * Re-arm the link of a number this object adopted that the hub has not confirmed yet (a sign-in again, or a repeated START, after an
   * earlier link attempt was given up): an obligation is created when there is a grant and none is pending. Returns whether one is pending.
   */
  rearm(phones) {
    return this.#serial(async () => {
      if (await this.#storage.get(PENDING)) return true;
      const linked = (await this.#storage.get(LINKED)) ?? [];
      const phone = phones.find(item => !linked.includes(item));
      if (!phone || !this.#env.HUB_APP_KEY || !hubOrigin(this.#env) || !await this.#storage.get(GRANT)) return false;
      await this.#storage.put(PENDING, { phone, version: crypto.randomUUID(), attempts: 0 });
      return true;
    });
  }

  /** Make sure a pending obligation has its job (after an adoption, its replay, or a restart). Idempotent (singleflight). */
  async ensureJob() {
    if (await this.#storage.get(PENDING)) await this.lifecycle.jobs.push({ id: 'hub-identity', fn: 'hub-identity', time: Date.now(), singleflight: true });
  }

  onStart() { void this.ensureJob().catch(error => console.warn('hub identity: job not armed', String(error?.message ?? error).slice(0, 200))); }

  /** A usable access token from grant `held`: its own, or a refreshed one, stored only while `held` is still the current grant. */
  async #accessToken(held, { force = false } = {}) {
    if (!force && held.accessToken && held.accessExpires - MARGIN > Date.now() / 1000) return held.accessToken;
    if (!held.refreshToken) return undefined;
    const settings = oidcSettings(this.#env, '');
    if (!settings) return undefined;
    const fresh = await refreshAccess(settings, { refreshToken: held.refreshToken, resource: held.resource }, this.#fetch);
    const next = { ...held, ...fresh, refreshToken: fresh.refreshToken ?? held.refreshToken };
    // The rotated refresh token is stored before anything else happens: the old one is spent.
    await this.#serial(async () => { if ((await this.#storage.get(GRANT))?.version === held.version) await this.#storage.put(GRANT, next); });
    Object.assign(held, next);
    await this.#crash('after-grant-refresh');
    return fresh.accessToken;
  }

  async #post(phone, token) {
    const response = await this.#fetch(`${hubOrigin(this.#env)}/v1/app/whatsapp-identity`, { method: 'POST',
      headers: { authorization: `Bearer ${this.#env.HUB_APP_KEY}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ subjectToken: token, phone }) });
    const after = Number(response.headers.get('retry-after'));
    return { status: response.status, body: await response.json().catch(() => ({})), ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {}) };
  }

  async onJob({ job }) {
    if (job.fn !== 'hub-identity') return undefined;
    // The obligation and the grant this run works on, captured together; a newer login or START replaces them under new versions.
    // Read fresh each run: after a crash the rotated grant stored before it is the one used.
    const [pending, grant] = await this.#serial(async () => [await this.#storage.get(PENDING), await this.#storage.get(GRANT)]);
    if (!pending) return undefined;
    let outcome, waitMs = 0;
    try {
      let token = grant ? await this.#accessToken(grant) : undefined;
      if (!token) outcome = 'no usable access token (no grant, or expired without a refresh token)';
      else {
        let result = await this.#post(pending.phone, token);
        // The hub refused the proof (expired early, revoked): one refresh, one more try.
        if (result.status === 401 && result.body?.error?.code === 'invalid_user_proof' && (token = await this.#accessToken(grant, { force: true }))) result = await this.#post(pending.phone, token);
        outcome = result.status === 200 ? `linked (${result.body?.created === false ? 'already' : 'new'})`
          : result.body?.error?.retryable === true || result.status === 429 || result.status >= 500 ? 'retry' : `refused (${result.status} ${String(result.body?.error?.code ?? '').slice(0, 40)})`;
        if (result.retryAfterMs) waitMs = result.retryAfterMs;
      }
    } catch (error) {
      // Only a refusal of the grant itself (400/401: invalid_grant, invalid_client...) is final; throttling (429), 5xx and network
      // failures are retried, after Retry-After when the hub gives one.
      outcome = (error?.status === 400 || error?.status === 401) ? `refresh refused (${error.status} ${String(error.code ?? '').slice(0, 40)})` : 'retry';
      waitMs = error?.retryAfterMs ?? 0;
    }
    const delays = retries(this.#env), settle = outcome !== 'retry' || pending.attempts >= delays.length;
    const linked = outcome.startsWith('linked');
    // Only the versions this run processed are updated or removed; a newer obligation is run next, with the grant it needs.
    const newer = await this.#serial(async () => {
      const current = await this.#storage.get(PENDING);
      if (current?.version !== pending.version) return Boolean(current);
      if (!settle) { await this.#storage.put(PENDING, { ...current, attempts: current.attempts + 1 }); return false; }
      const held = await this.#storage.get(GRANT);
      // A failure with a grant a newer sign-in has replaced since this run read it says nothing about the new grant: keep the
      // obligation and run again at once with the current grant.
      if (!linked && held && held.version !== grant?.version) { await this.#storage.put(PENDING, { ...current, attempts: 0 }); return true; }
      if (linked) await this.#storage.put(LINKED, [...new Set([...((await this.#storage.get(LINKED)) ?? []), pending.phone])]);
      await this.#storage.delete(held && grant && held.version === grant.version ? [PENDING, GRANT] : [PENDING]);
      return false;
    });
    if (settle && !newer) console.log(`hub identity: ${outcome === 'retry' ? 'gave up after retries' : outcome}`);
    if (newer) return { rescheduleAt: Date.now() };
    return settle ? undefined : { rescheduleAt: Date.now() + Math.max(delays[pending.attempts], waitMs) };
  }
}
