// The Worker's own registry of people (one SQLite-backed Durable Object, `getByName('registry')`): one-time signup codes and which
// WhatsApp number belongs to which person's agent. It is the routing source of truth; the hub's copy of the phone link is best effort
// (see hub.mjs). Reached only over RPC from the Worker, never over HTTP. Fictional fixtures only in tests.
//
// A code is 6 characters from an alphabet without look-alikes (no 0/O, 1/I/L), valid 10 minutes, single use, and bound to the person
// (hub subject, email, their object) and the phone number they typed. It is redeemed only by a WhatsApp message from that number.
import { DurableObject } from 'cloudflare:workers';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60_000;
/** Wrong codes one number may send per day before every code from it is refused. */
const MAX_FAILURES = 10;
/** One "sign up at ..." reply per unknown number per day. */
const NUDGE_EVERY_MS = 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
/** A redemption is remembered by its message this long (Meta redelivers for about 7 days), so its replay always succeeds. */
const REDEEMED_KEEP_MS = 8 * DAY_MS;
/** An adoption the Worker did not confirm is retried by the registry's alarm this often. */
const ADOPT_RETRY_MS = 15_000;
const adoptKey = (object, phone) => `adopt:${object}|${phone}`;
/** When an unconfirmed adoption is (re)tried: 15 s after the redemption, then 15 s after each failed try. */
const adoptDue = entry => entry.retryAt ?? entry.at + ADOPT_RETRY_MS;

/** A fresh code: uniform over the alphabet (rejection sampling, no modulo bias). */
export function newCode() {
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte >= 256 - (256 % CODE_ALPHABET.length)) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

/** `START <code>` (any case, extra spaces allowed), or undefined. */
export function startCode(text) {
  const found = /^\s*start\s+([a-z0-9]{6})\s*[.!]?\s*$/i.exec(String(text ?? ''));
  return found ? found[1].toUpperCase() : undefined;
}

/**
 * A phone number as E.164 (`+41791234567`), or undefined. Spaces, dashes, dots and brackets are ignored; `00` is an international
 * prefix; a national number starting with one `0` takes `defaultCountry` (digits, e.g. "41"); bare digits are taken as international. A
 * WhatsApp ID is the digits without `+`.
 */
export function normalizePhone(input, defaultCountry) {
  let text = String(input ?? '').trim().replace(/[\s().-]/g, '');
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  else if (/^0[1-9]/.test(text) && defaultCountry && /^[1-9]\d{0,3}$/.test(defaultCountry)) text = `+${defaultCountry}${text.slice(1)}`;
  else if (/^[1-9]\d{6,14}$/.test(text)) text = `+${text}`;
  return /^\+[1-9]\d{6,14}$/.test(text) ? text : undefined;
}
/** The E.164 form of a WhatsApp ID (digits). */
export const phoneOfWhatsAppId = id => normalizePhone(`+${String(id ?? '').replace(/^\+/, '')}`);

export class Registry extends DurableObject {
  #storage = this.ctx.storage;
  /** Every read-modify-write runs alone (input gates already serialize storage calls; this also covers any await in between). */
  #queue = Promise.resolve();
  #serial(work) { const run = this.#queue.then(work); this.#queue = run.catch(() => undefined); return run; }

  /** Issue a code for one person and the number they claimed. `person` is `{ object, subject, email }`. No token is kept here. */
  issue(input) { return this.#serial(() => this.#issue(input)); }

  async #issue({ person, phone }) {
    const now = Date.now();
    let code;
    do code = newCode(); while (await this.#storage.get(`code:${code}`));
    const expiresAt = now + CODE_TTL_MS;
    await this.#storage.put(`code:${code}`, { person, phone, expiresAt });
    // Remove expired codes soon after they expire.
    await this.#armAlarm(expiresAt + 60_000);
    return { code, expiresAt };
  }

  /**
   * A `START <code>` from `phone` (E.164), message `messageId`. `{ status: 'linked', person, phone, again }` when the code is
   * unexpired, unused (or used by this very message: `again`, a webhook redelivery) and was claimed for this number; the number now
   * routes to the person's object. Otherwise `{ status: 'refused', reason }`: unknown, expired, used, another number, too many failures,
   * or `owned`: the number already belongs to another person (`ownerNumber`: one of the owner's WHATSAPP_ALLOWED numbers, which only
   * the owner's 'main' may claim). A number never moves between people here (as at the hub, 409 `phone_already_linked`): the operator
   * frees it, so no agent ever keeps a number it no longer owns.
   */
  redeem(input) { return this.#serial(() => this.#redeem(input)); }

  async #redeem({ code, phone, messageId, ownerNumber = false }) {
    // A redemption already committed for this message: its replay succeeds whatever happened since (code cleaned up, sign-ups closed).
    const done = await this.#storage.get(`redeemed:${messageId}`);
    if (done && done.phone === phone) return { status: 'linked', person: done.person, phone, again: true };
    const now = Date.now(), failures = (await this.#storage.get(`failures:${phone}`)) ?? { day: 0, count: 0 };
    const today = Math.floor(now / DAY_MS);
    if (failures.day === today && failures.count >= MAX_FAILURES) return { status: 'refused', reason: 'too-many' };
    const entry = await this.#storage.get(`code:${code}`);
    const fail = async reason => { await this.#storage.put(`failures:${phone}`, { day: today, count: failures.day === today ? failures.count + 1 : 1 }); return { status: 'refused', reason }; };
    if (!entry) return fail('unknown');
    if (entry.usedBy) return entry.usedBy === messageId ? { status: 'linked', person: entry.person, phone, again: true } : fail('used');
    if (entry.expiresAt <= now) return fail('expired');
    if (entry.phone !== phone) return fail('other-number');
    const previous = await this.#storage.get(`phone:${phone}`);
    if ((previous && previous.object !== entry.person.object) || (ownerNumber && entry.person.object !== 'main')) return { status: 'refused', reason: 'owned' };
    // One write: the code used, the number routed, the membership, the redemption by message, and the obligation to tell the person's
    // object (adopt), which the alarm retries until the Worker or the alarm confirms it, so a Worker dying here loses nothing.
    await this.#storage.put({ [`code:${code}`]: { ...entry, usedBy: messageId }, ...(previous ? {} : { [`phone:${phone}`]: { ...entry.person, linkedAt: now } }),
      [`member:${entry.person.object}`]: { subject: entry.person.subject, since: now }, [`redeemed:${messageId}`]: { person: entry.person, phone, at: now },
      [adoptKey(entry.person.object, phone)]: { person: entry.person, phone, at: now } });
    await this.#armAlarm(now + ADOPT_RETRY_MS);
    return { status: 'linked', person: entry.person, phone, again: false };
  }

  /** A redemption that is only a replay (`START` from a redelivered message): `{ status: 'linked', ..., again: true }` or undefined. */
  async replay({ messageId, phone }) {
    const done = await this.#storage.get(`redeemed:${messageId}`);
    return done && done.phone === phone ? { status: 'linked', person: done.person, phone, again: true } : undefined;
  }

  /** The person's object confirmed the adoption of `phone`: the obligation is settled. */
  adopted({ object, phone }) { return this.#serial(() => this.#storage.delete(adoptKey(object, phone))); }

  async #armAlarm(at) {
    const current = await this.#storage.getAlarm();
    if (!current || current > at) await this.#storage.setAlarm(at);
  }

  /** Debug-only (ENABLE_DEBUG_ROUTES=1, the signup journey): arm a one-shot crash point the Worker takes. */
  async arm(name) { await this.#storage.put(`debug:${name}`, true); }
  take(name) { return this.#serial(async () => { const armed = await this.#storage.get(`debug:${name}`); if (armed) await this.#storage.delete(`debug:${name}`); return Boolean(armed); }); }

  /** Whether this person's object has an agent here (a number was linked once): they may sign in again when sign-ups are closed. */
  async member(object) { return Boolean(await this.#storage.get(`member:${object}`)); }

  /** The person a number routes to (`{ object, subject, email }`), or undefined. */
  async phone(phone) { return (await this.#storage.get(`phone:${phone}`)) ?? undefined; }

  /** Whether an unknown number should get the "sign up at ..." reply now (at most once a day). */
  nudge(phone) { return this.#serial(() => this.#nudge(phone)); }

  async #nudge(phone) {
    const now = Date.now(), last = await this.#storage.get(`nudge:${phone}`);
    if (typeof last === 'number' && now - last < NUDGE_EVERY_MS) return false;
    await this.#storage.put(`nudge:${phone}`, now);
    return true;
  }

  async alarm() {
    const now = Date.now();
    await this.#serial(async () => {
      for (const [key, entry] of await this.#storage.list({ prefix: 'code:' })) if (entry.expiresAt + 60_000 <= now) await this.#storage.delete(key);
      for (const [key, entry] of await this.#storage.list({ prefix: 'redeemed:' })) if (entry.at + REDEEMED_KEEP_MS <= now) await this.#storage.delete(key);
    });
    // Adoptions the Worker never confirmed (it died after the redemption): told to the person's object until it acknowledges.
    for (const [key, entry] of await this.#storage.list({ prefix: 'adopt:' })) {
      if (adoptDue(entry) > now) continue;
      try {
        await this.env.ASSISTANT.getByName(entry.person.object).adopt({ phone: entry.phone, subject: entry.person.subject });
        await this.#serial(() => this.#storage.delete(key));
      } catch (error) {
        console.warn('signup: adoption not confirmed yet', String(error?.message ?? error).slice(0, 200));
        await this.#serial(async () => { const current = await this.#storage.get(key); if (current) await this.#storage.put(key, { ...current, retryAt: Date.now() + ADOPT_RETRY_MS }); });
      }
    }
    // The next wake-up from CURRENT storage (a redemption may have landed while an adoption call was awaited), serialized with
    // redemptions, and never later than an alarm already set: setAlarm replaces, so an older snapshot must not push a newer one out.
    await this.#serial(async () => { const next = await this.#nextDue(); if (next !== undefined) await this.#armAlarm(next); });
  }

  /** The earliest time any kept record needs the alarm: a code to remove, a redemption record to forget, an adoption to retry. */
  async #nextDue() {
    let next;
    const due = at => { next = Math.min(next ?? Infinity, at); };
    for (const [, entry] of await this.#storage.list({ prefix: 'code:' })) due(entry.expiresAt + 60_000);
    for (const [, entry] of await this.#storage.list({ prefix: 'redeemed:' })) due(entry.at + REDEEMED_KEEP_MS);
    for (const [, entry] of await this.#storage.list({ prefix: 'adopt:' })) due(adoptDue(entry));
    return next;
  }
}
