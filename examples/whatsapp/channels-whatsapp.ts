import type { ChannelAdapter, ChannelMessage, ChannelReceipt, ChannelReply } from './channels.ts';

/**
 * WhatsApp Business Cloud API edge for `createChannelGateway`, ported from boring-ui-v2 `@hachej/channel-whatsapp`:
 * webhook challenge and `X-Hub-Signature-256` verification over the raw body, text and interactive replies in,
 * text, reply buttons and lists out. It holds no conversation state.
 */
export const WHATSAPP = Object.freeze({
  channel: 'whatsapp', bodyLimit: 1_048_576, graphOrigin: 'https://graph.facebook.com', apiVersion: 'v25.0', maxText: 4096,
  maxButtons: 3, maxButtonTitle: 20, maxRows: 10, maxRowTitle: 24, maxInteractiveBody: 1024,
  /**
   * Meta's customer service window: free-form messages reach a person only within 24 hours of their last message; outside it
   * only an approved template does. Five minutes are kept back for clock skew and the send itself.
   */
  replyWindowMs: 24 * 60 * 60 * 1000 - 5 * 60 * 1000,
});

/** Host-owned secrets. Only `withCredentials` sees them, for the length of one call. */
export interface WhatsAppCredentials {
  readonly accessToken: string;
  readonly appSecret: string;
  readonly verifyToken: string;
  /** The business phone number ID that sends replies; webhooks for other numbers are ignored. */
  readonly phoneNumberId: string;
  readonly apiVersion?: string;
}

export interface WhatsAppChannelOptions {
  readonly withCredentials: <T>(use: (credentials: WhatsAppCredentials) => T | Promise<T>) => Promise<T>;
  readonly fetch?: typeof fetch;
  readonly graphOrigin?: string;
  readonly bodyLimit?: number;
  readonly now?: () => number;
  /** Mark each admitted message read and show the typing indicator. Default true. */
  readonly typingIndicator?: boolean;
  /** Override Meta's reply window (`WHATSAPP.replyWindowMs`); tests only. */
  readonly replyWindowMs?: number;
  /**
   * An approved template (no variables) sent outside the reply window to invite the person to write, for example "Your
   * scheduled task has a result: reply to see it." A template does not reopen the window for free-form text: the held reply
   * still goes when the person answers. Without one, the reply simply waits for their next message.
   */
  readonly inviteTemplate?: { readonly name: string; readonly language: string };
}

/** Meta's own identifiers of a failed call: enough to diagnose it or quote it to Meta support. Never a token or message text. */
export interface WhatsAppApiErrorDetail { readonly code?: number; readonly subcode?: number; readonly type?: string; readonly fbtraceId?: string }

export class WhatsAppApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly detail: WhatsAppApiErrorDetail;
  constructor(status: number, retryable: boolean, detail: WhatsAppApiErrorDetail = {}) {
    const parts = [detail.code === undefined ? '' : `code ${detail.code}`, detail.subcode === undefined ? '' : `subcode ${detail.subcode}`, detail.fbtraceId ? `fbtrace ${detail.fbtraceId}` : ''].filter(Boolean);
    super(`WhatsApp Cloud API request failed (${status}${parts.length ? `; ${parts.join(', ')}` : ''})`);
    this.name = 'WhatsAppApiError';
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

type Payload = Record<string, unknown>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const respond = (status: number, body: string): ChannelReceipt => ({ kind: 'response', response: new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }) });

export function createWhatsAppChannel(options: WhatsAppChannelOptions): ChannelAdapter {
  const request = options.fetch ?? fetch;
  const origin = (options.graphOrigin ?? WHATSAPP.graphOrigin).replace(/\/$/, '');
  const limit = options.bodyLimit ?? WHATSAPP.bodyLimit;

  async function post(payload: Payload, credentials: WhatsAppCredentials): Promise<void> {
    const version = credentials.apiVersion ?? WHATSAPP.apiVersion;
    if (!/^v\d+\.\d+$/.test(version) || !/^\d+$/.test(credentials.phoneNumberId)) throw new WhatsAppApiError(0, false);
    const response = await request(`${origin}/${version}/${credentials.phoneNumberId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${credentials.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    if (response.ok) return;
    let transient = false, code: number | undefined, detail: WhatsAppApiErrorDetail = {};
    try {
      const body: unknown = await response.json();
      if (record(body) && record(body['error'])) {
        const error = body['error'];
        transient = error['is_transient'] === true;
        code = typeof error['code'] === 'number' ? error['code'] : undefined;
        detail = { ...(code === undefined ? {} : { code }), ...(typeof error['error_subcode'] === 'number' ? { subcode: error['error_subcode'] } : {}),
          ...(typeof error['type'] === 'string' ? { type: error['type'].slice(0, 60) } : {}), ...(typeof error['fbtrace_id'] === 'string' ? { fbtraceId: error['fbtrace_id'].slice(0, 60) } : {}) };
      }
    } catch { /* HTTP status still classifies it */ }
    const retryable = transient || (code !== undefined && [1, 2, 4, 17, 32, 613, 80007].includes(code)) || response.status === 408 || response.status === 429 || response.status >= 500;
    throw new WhatsAppApiError(response.status, retryable, detail);
  }

  return {
    id: WHATSAPP.channel,
    receive: async incoming => options.withCredentials(async credentials => {
      const method = incoming.method.toUpperCase();
      if (method === 'GET') return challenge(incoming.url, credentials.verifyToken);
      if (method !== 'POST') return respond(405, 'method not allowed');
      const announced = Number(incoming.headers.get('content-length') ?? 0);
      if (Number.isFinite(announced) && announced > limit) return respond(413, 'payload too large');
      const body = await readBody(incoming, limit);
      if (!body) return respond(413, 'payload too large');
      const signature = incoming.headers.get('x-hub-signature-256');
      if (!signature || !await verifyWhatsAppSignature(body, signature, credentials.appSecret)) return respond(401, 'invalid signature');
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(body)); } catch { return respond(400, 'invalid json'); }
      try { return { kind: 'messages', messages: parseWhatsAppMessages(payload, { phoneNumberId: credentials.phoneNumberId, receivedAt: options.now?.() ?? Date.now() }) }; }
      catch { return respond(400, 'invalid envelope'); }
    }),
    send: async (address, reply) => options.withCredentials(async credentials => {
      for (const payload of renderWhatsAppReply(reply)) await post({ recipient_type: 'individual', to: address, ...payload }, credentials);
    }),
    replyWindowMs: options.replyWindowMs ?? WHATSAPP.replyWindowMs,
    ...(options.inviteTemplate ? { invite: async (address: string) => options.withCredentials(credentials =>
      post({ recipient_type: 'individual', to: address, type: 'template', template: { name: options.inviteTemplate!.name, language: { code: options.inviteTemplate!.language } } }, credentials)) } : {}),
    ...(options.typingIndicator === false ? {} : {
      received: async (message: ChannelMessage) => options.withCredentials(credentials =>
        post({ status: 'read', message_id: message.messageId, typing_indicator: { type: 'text' } }, credentials)),
    }),
  };
}

function challenge(url: string, verifyToken: string): ChannelReceipt {
  const query = new URL(url, 'https://webhook.invalid').searchParams;
  const value = query.get('hub.challenge'), supplied = query.get('hub.verify_token');
  const encode = (text: string) => new TextEncoder().encode(text);
  if (query.get('hub.mode') !== 'subscribe' || value === null || supplied === null || !constantTimeEqual(encode(supplied), encode(verifyToken))) return respond(403, 'verification failed');
  return respond(200, value);
}

/** Verify Meta's `sha256=<hex>` HMAC of the exact raw body. */
export async function verifyWhatsAppSignature(body: Uint8Array, signature: string, appSecret: string): Promise<boolean> {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, Uint8Array.from(body).buffer));
  const expected = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) expected[index] = Number.parseInt(signature.slice(7 + index * 2, 9 + index * 2), 16);
  return constantTimeEqual(digest, expected);
}

/**
 * Text and interactive (button/list) messages of a verified webhook body. Status callbacks, other phone numbers and
 * unsupported media are skipped; a malformed envelope throws.
 */
export function parseWhatsAppMessages(payload: unknown, options: { readonly phoneNumberId?: string; readonly receivedAt?: number } = {}): ChannelMessage[] {
  const receivedAt = options.receivedAt ?? Date.now();
  if (!record(payload) || payload['object'] !== 'whatsapp_business_account' || !Array.isArray(payload['entry'])) throw new Error('Invalid WhatsApp webhook envelope');
  const out: ChannelMessage[] = [];
  for (const entry of payload['entry']) {
    if (!record(entry) || !Array.isArray(entry['changes'])) throw new Error('Invalid WhatsApp webhook entry');
    for (const change of entry['changes']) {
      if (!record(change) || typeof change['field'] !== 'string' || !record(change['value'])) throw new Error('Invalid WhatsApp webhook change');
      const value = change['value'];
      if (change['field'] !== 'messages') continue;
      const metadata = record(value['metadata']) ? value['metadata'] : {};
      if (options.phoneNumberId !== undefined && metadata['phone_number_id'] !== options.phoneNumberId) continue;
      if (!Array.isArray(value['messages'])) { if (Array.isArray(value['statuses'])) continue; throw new Error('Invalid WhatsApp messages change'); }
      for (const message of value['messages']) {
        if (!record(message) || typeof message['id'] !== 'string' || typeof message['from'] !== 'string' || typeof message['type'] !== 'string') throw new Error('Invalid WhatsApp message');
        const text = inboundText(message);
        if (text === undefined) continue;
        const stamp = typeof message['timestamp'] === 'string' && /^\d+$/.test(message['timestamp']) ? Number(message['timestamp']) * 1000 : receivedAt;
        const choice = choiceOf(message);
        out.push({ channel: WHATSAPP.channel, address: message['from'], messageId: message['id'], text, receivedAt: Number.isSafeInteger(stamp) ? stamp : receivedAt, ...(choice ? { choice } : {}) });
      }
    }
  }
  return out;
}

/** Option ids name their question: `q:` + base64url of `[question, option]`. WhatsApp allows 256 characters per id. */
export function encodeChoice(question: string, option: string): string | undefined {
  const id = `q:${btoa(unescape(encodeURIComponent(JSON.stringify([question, option])))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  return id.length <= 256 ? id : undefined;
}
export function decodeChoice(id: string): { question: string; option: string } | undefined {
  if (!id.startsWith('q:')) return undefined;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(escape(atob(id.slice(2).replace(/-/g, '+').replace(/_/g, '/')))));
    return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' ? { question: value[0], option: value[1] } : undefined;
  } catch { return undefined; }
}
/**
 * A tapped button or list row. One we sent names its question in the id; any other (an older build's plain "Approve", a
 * template quick reply) gets the empty question, which matches no open question, so it can never answer one as text.
 */
function choiceOf(message: Record<string, unknown>): { question: string; option: string } | undefined {
  const interactive = message['interactive'], button = message['button'];
  if (message['type'] === 'button' && record(button)) return { question: '', option: typeof button['text'] === 'string' ? button['text'] : '' };
  if (message['type'] !== 'interactive' || !record(interactive)) return undefined;
  const choice = interactive['type'] === 'button_reply' ? interactive['button_reply'] : interactive['list_reply'];
  if (!record(choice)) return undefined;
  return (typeof choice['id'] === 'string' ? decodeChoice(choice['id']) : undefined)
    ?? { question: '', option: typeof choice['title'] === 'string' ? choice['title'] : '' };
}

function inboundText(message: Record<string, unknown>): string | undefined {
  const text = message['text'], interactive = message['interactive'], button = message['button'];
  if (message['type'] === 'text' && record(text) && typeof text['body'] === 'string') return text['body'];
  if (message['type'] === 'button' && record(button) && typeof button['text'] === 'string') return button['text'];
  if (message['type'] === 'interactive' && record(interactive)) {
    const choice = interactive['type'] === 'button_reply' ? interactive['button_reply'] : interactive['list_reply'];
    // Our buttons and rows carry their question and option in the id (see encodeChoice); the text is the option.
    if (record(choice)) {
      const decoded = typeof choice['id'] === 'string' ? decodeChoice(choice['id']) : undefined;
      if (decoded) return decoded.option;
      return typeof choice['id'] === 'string' ? choice['id'] : typeof choice['title'] === 'string' ? choice['title'] : undefined;
    }
  }
  return undefined;
}

/** Graph API message payloads (without `to`) for one gateway reply. */
export function renderWhatsAppReply(reply: ChannelReply): Payload[] {
  const text = (body: string): Payload[] => splitWhatsAppText(body, WHATSAPP.maxText).map(chunk => ({ type: 'text', text: { body: chunk, preview_url: false } }));
  if (reply.kind === 'notice') return text(reply.text);
  if (reply.kind === 'answer') return text(whatsAppMarkdown(reply.markdown));
  const prompt = whatsAppMarkdown(reply.prompt);
  const { options } = reply;
  const fits = (max: number) => options.every(option => [...option].length <= max);
  const ids = options.map(option => encodeChoice(reply.callId, option));
  // Interactive options must name their question; when an id would not fit, fall back to numbered text.
  if (options.length && prompt.length <= WHATSAPP.maxInteractiveBody && ids.every(id => id !== undefined)) {
    const footer = reply.allowFreeText ? { footer: { text: 'Or type your own answer.' } } : {};
    if (options.length <= WHATSAPP.maxButtons && fits(WHATSAPP.maxButtonTitle)) {
      return [{ type: 'interactive', interactive: { type: 'button', body: { text: prompt }, ...footer,
        action: { buttons: options.map((option, index) => ({ type: 'reply', reply: { id: ids[index], title: option } })) } } }];
    }
    if (options.length <= WHATSAPP.maxRows && fits(WHATSAPP.maxRowTitle)) {
      return [{ type: 'interactive', interactive: { type: 'list', body: { text: prompt }, ...footer,
        action: { button: 'Choose', sections: [{ title: 'Options', rows: options.map((option, index) => ({ id: ids[index], title: option })) }] } } }];
    }
  }
  const numbered = options.map((option, index) => `${index + 1}. ${option}`).join('\n');
  const hint = options.length ? (reply.allowFreeText ? 'Reply with a number or your own answer.' : 'Reply with a number.') : 'Reply with your answer.';
  return text([prompt, numbered, hint].filter(Boolean).join('\n\n'));
}

/** WhatsApp formatting: no headings, `*bold*`, `_italic_`; code fences are kept. */
export function whatsAppMarkdown(markdown: string): string {
  let fenced = false;
  return markdown.split(/(```)/g).map(section => {
    if (section === '```') { fenced = !fenced; return section; }
    if (fenced) return section;
    return section.replace(/^#{1,6}\s+(.*)$/gm, '**$1**')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1_$2_')
      .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
      .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)');
  }).join('');
}

/** Split at paragraph, then line boundaries; an open code fence is closed and reopened across chunks. */
export function splitWhatsAppText(text: string, max: number): string[] {
  const chunks: string[] = [];
  const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
  let rest = text;
  while (rest.length > max) {
    let split = rest.lastIndexOf('\n\n', max);
    if (split < max / 2) split = rest.lastIndexOf('\n', max);
    if (split < max / 2) split = max;
    if (split > 0 && high(rest.charCodeAt(split - 1))) split -= 1;
    let chunk = rest.slice(0, split);
    rest = rest.slice(split).replace(/^\n+/, '');
    if ((chunk.match(/```/g) ?? []).length % 2 === 1) {
      const close = '\n```';
      if (chunk.length + close.length > max) {
        let keep = max - close.length;
        if (keep > 0 && high(chunk.charCodeAt(keep - 1))) keep -= 1;
        rest = chunk.slice(keep) + rest; chunk = chunk.slice(0, keep);
      }
      chunk += close; rest = '```\n' + rest;
    }
    chunks.push(chunk);
  }
  if (rest.length || !chunks.length) chunks.push(rest);
  return chunks;
}

async function readBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) { await reader.cancel(); return undefined; }
    parts.push(next.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return body;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < Math.max(left.byteLength, right.byteLength); index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
