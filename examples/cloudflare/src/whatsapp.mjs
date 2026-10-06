// WhatsApp for the Durable Object: a Lifecycle capability that answers Meta's webhook at /whatsapp and hands each message to the
// channel gateway (examples/whatsapp). The gateway turns a message into native input on the sender's own conversation and sends
// the settled answer back. Replies still owed after an eviction are picked up again by a recurring Lifecycle job, so a reply is
// not lost when the object restarts between the agent's answer and the send. Credentials are Worker secrets; nothing here logs them.
// Scheduled runs come in through `dispatch` and are answered like a message. Meta only lets free-form text through within 24 hours
// of the person's last message: a reply due later is held (with an optional invite template) until they write again.
import { LifecycleCapability } from 'agents/lifecycle';
import { createChannelGateway } from '../../whatsapp/channels.ts';
import { createWhatsAppChannel } from '../../whatsapp/channels-whatsapp.ts';

export const WHATSAPP_PATH = '/whatsapp';
/** How often an object that still owes replies checks them again. */
const OWED_CHECK_MS = 60_000;
// WHATSAPP_ALLOWED (the owner's numbers) is optional once people sign up: their numbers come from the registry (see signup.mjs).
const REQUIRED = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];

/** The WhatsApp settings of the Worker environment, or undefined when the channel is not configured. */
export function whatsAppSettings(env) {
  if (!REQUIRED.every(name => typeof env[name] === 'string' && env[name])) return undefined;
  return {
    credentials: { accessToken: env.WHATSAPP_ACCESS_TOKEN, appSecret: env.WHATSAPP_APP_SECRET, verifyToken: env.WHATSAPP_VERIFY_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, ...(env.WHATSAPP_API_VERSION ? { apiVersion: env.WHATSAPP_API_VERSION } : {}) },
    // WhatsApp IDs are digits without "+": "41790000000,15550001".
    allowed: (env.WHATSAPP_ALLOWED ?? '').split(',').map(value => value.trim().replace(/^\+/, '').replace(/\s+/g, '')).filter(Boolean),
    // Only for local journeys: send Graph API calls to a stand-in instead of graph.facebook.com.
    ...(env.WHATSAPP_GRAPH_ORIGIN ? { graphOrigin: env.WHATSAPP_GRAPH_ORIGIN } : {}),
    // An approved template (no variables) sent when a scheduled reply is held outside the 24-hour window, inviting the person to write.
    ...(env.WHATSAPP_WAKE_TEMPLATE ? { inviteTemplate: { name: env.WHATSAPP_WAKE_TEMPLATE, language: env.WHATSAPP_WAKE_TEMPLATE_LANG || 'en_US' } } : {}),
  };
}

/** The Meta adapter over these settings: webhook verification and parsing, and sends (the Worker uses it for signup replies). */
export const whatsAppAdapter = settings => createWhatsAppChannel({ withCredentials: use => Promise.resolve(use(settings.credentials)),
  ...(settings.graphOrigin ? { graphOrigin: settings.graphOrigin } : {}), ...(settings.inviteTemplate ? { inviteTemplate: settings.inviteTemplate } : {}) });

export class WhatsAppChannel extends LifecycleCapability {
  #settings; #pi; #conversationFor; #admit; #admitInput; #resolve; #context; #beforeSend; #gateway;

  /**
   * @param {object} options
   * @param {ReturnType<typeof whatsAppSettings>} options.settings
   * @param {() => Promise<object>} options.pi the native Harness
   * @param {(address: string) => Promise<object>} options.conversationFor this sender's conversation, admitting through the host's path
   * @param {(message: object) => Promise<true | false | string>} options.admit host policy for one message: true admits it, false
   *   refuses it silently, a string refuses it and sends that text to the sender
   * @param {(conversationId: unknown) => Promise<object | undefined>} [options.resolve] a conversation by ID through the host's
   *   admission path, for recovering an owed input (the gateway's `conversation`)
   * @param {Function} [options.admitInput] host policy for a message classified as new input (the gateway's `admitInput`: a daily
   *   turn cap, which never applies to an answer to an open question or a redelivery)
   * @param {object} options.context
   * @param {Function} [options.beforeSend] debug-only delivery barrier (debug-holds.mjs); a deployment passes none
   */
  constructor({ settings, pi, conversationFor, admit, admitInput, resolve, context, beforeSend }) {
    super('whatsapp-channel');
    this.#settings = settings; this.#pi = pi; this.#conversationFor = conversationFor; this.#admit = admit; this.#admitInput = admitInput; this.#resolve = resolve; this.#context = context; this.#beforeSend = beforeSend;
  }

  #open() {
    this.#gateway ??= (async () => {
      const settings = this.#settings, adapter = whatsAppAdapter(settings);
      return createChannelGateway({ harness: await this.#pi(), context: this.#context, adapters: [adapter],
        // Host policy: admitted senders only (the owner's allow-list, a person's own linked number), one conversation each.
        route: async message => {
          const verdict = await this.#admit(message);
          if (verdict === true) return this.#conversationFor(message.address);
          if (typeof verdict === 'string') await adapter.send(message.address, { kind: 'notice', text: verdict }).catch(error => console.warn('whatsapp notice failed', String(error?.message ?? error).slice(0, 200)));
          return null;
        },
        ...(this.#beforeSend ? { beforeSend: this.#beforeSend } : {}), ...(this.#admitInput ? { admitInput: this.#admitInput } : {}), ...(this.#resolve ? { conversation: this.#resolve } : {}),
        onEvent: event => {
          if (event.kind === 'refused' || event.kind === 'undeliverable') console.warn(`whatsapp ${event.kind}${event.reason ? `: ${event.reason}` : ''}`);
          if (event.kind === 'held') console.log(`whatsapp ${event.reply} held for the 24-hour window until the person writes (${event.invited ? 'invite template sent' : 'no invite'})`);
        } });
    })();
    this.#gateway.catch(() => { this.#gateway = undefined; });
    return this.#gateway;
  }

  /** Resume replies owed before a restart, and keep checking while any remain. */
  async #resume() {
    const gateway = await this.#open();
    await gateway.start();
    if (await gateway.owed() > 0) await this.lifecycle.jobs.push({ id: 'owed', fn: 'owed', time: Date.now() + OWED_CHECK_MS, singleflight: true });
  }

  onStart() {
    // Not awaited: startup must not wait on the harness or the network.
    void this.#resume().catch(error => console.error('whatsapp resume failed', String(error?.message ?? error)));
  }

  async onRequest({ request }) {
    if (new URL(request.url).pathname !== WHATSAPP_PATH) return undefined;
    const gateway = await this.#open();
    const response = await gateway.handler('whatsapp')(request);
    if (request.method === 'POST' && response.ok) await this.lifecycle.jobs.push({ id: 'owed', fn: 'owed', time: Date.now() + OWED_CHECK_MS, singleflight: true });
    return response;
  }

  /**
   * A scheduled run: submit `text` to the sender's conversation as `requestId` and owe the reply to `address`. Idempotent on
   * `requestId`. Keeps the owed-reply job armed so the answer is delivered even across a restart.
   */
  async dispatch({ address, conversation, requestId, text }) {
    const gateway = await this.#open();
    const outcome = await gateway.dispatch({ channel: 'whatsapp', address, conversation, requestId, text });
    if (outcome === 'full') throw new Error('The WhatsApp outbox is full');
    await this.lifecycle.jobs.push({ id: 'owed', fn: 'owed', time: Date.now() + OWED_CHECK_MS, singleflight: true });
    return outcome;
  }

  /** Whether input `requestId` is still owed a reply here (its submission may still be recovered by the gateway). */
  async pending(requestId) { return (await this.#open()).pending(requestId); }

  async onJob({ job }) {
    if (job.fn !== 'owed') return undefined;
    const gateway = await this.#open();
    // Delivery waits for the agent's answer, which can take minutes: keep it running without blocking the job queue.
    this.lifecycle.trackAlarmWork(gateway.start());
    return await gateway.owed() > 0 ? { rescheduleAt: Date.now() + OWED_CHECK_MS } : undefined;
  }

  async dispose() { if (this.#gateway) await (await this.#gateway).close(); }
}
