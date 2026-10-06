import { defineDoc } from '@earendil-works/pi-durable';
import type { Conversation, ConversationId, ConversationView, EntryRecord, Harness, SettledSubmissionRecord } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import { withAbortSignal } from '@earendil-works/chord/context';
import { ASK_USER_TOOL, answerUserQuestion, askUserQuestionId } from '@boring/agent/ask-user';
import { APPROVAL_DETAILS, APPROVE, DENY } from '@boring/agent/approval';

/**
 * External messaging channels (WhatsApp, Telegram, Slack, SMS…) for a native durable conversation.
 *
 * A channel is an edge: it verifies the provider's webhook, parses messages and sends replies. Everything else stays
 * native: a message becomes `Conversation.submit` with the provider message ID as `requestId` (Pi deduplicates and
 * queues a busy conversation's input), and the reply is the submission's settled `answer` entry. The web chat watches
 * the same conversation, so a WhatsApp thread and the browser are two views of one session.
 */
export const CHANNELS = Object.freeze({ schema: 'boring.channels', version: 1, maxOutbox: 1000, maxText: 16_384 });

/** One verified inbound message, already reduced to text. */
export interface ChannelMessage {
  /** Adapter ID, e.g. `whatsapp`. */
  readonly channel: string;
  /** Provider-stable sender (thread) address: where replies go, e.g. the WhatsApp user ID. */
  readonly address: string;
  /** Provider message ID, stable across webhook redelivery. */
  readonly messageId: string;
  readonly text: string;
  readonly receivedAt: number;
  /**
   * A tap on an option: the exact question it belongs to, so it never answers another one. An adapter that cannot tell
   * which question a tapped option belongs to sets `question: ''`; the gateway then answers nothing and says the button is out of date.
   */
  readonly choice?: { readonly question: string; readonly option: string };
}

/** What the gateway asks an adapter to deliver. `markdown` is the agent's text; the adapter renders and splits it. */
export type ChannelReply =
  | { readonly kind: 'answer'; readonly markdown: string }
  | { readonly kind: 'question'; /** Assistant-entry-bound question ID. */ readonly callId: string; readonly prompt: string; readonly options: readonly string[]; readonly allowFreeText: boolean }
  | { readonly kind: 'notice'; readonly text: string };

/** The result of reading one webhook request. */
export type ChannelReceipt =
  /** Verified messages. The gateway acknowledges the request once each is durably admitted. */
  | { readonly kind: 'messages'; readonly messages: readonly ChannelMessage[] }
  /** Answer the request directly: a verification handshake, a refused signature, an oversized body… */
  | { readonly kind: 'response'; readonly response: Response };

/**
 * The universal channel contract. Trusted host code: it holds the provider credentials, never the conversation.
 * Function properties, not methods, so implementations are checked contravariantly.
 */
export interface ChannelAdapter {
  readonly id: string;
  /** Verify and parse a webhook request. Unverified input must return a `response`, never messages. */
  readonly receive: (request: Request) => Promise<ChannelReceipt>;
  /** Deliver one reply to `address`. Throw `{ retryable: true }` (or a network error) for a transient failure. */
  readonly send: (address: string, reply: ChannelReply) => Promise<void>;
  /** Optional receipt feedback after admission, such as a read mark and typing indicator. Failures are ignored. */
  readonly received?: (message: ChannelMessage) => Promise<void>;
  /**
   * The provider's reply window: free-form messages reach an address only this long after its last inbound message (WhatsApp:
   * 24 hours). A reply or question due later (a scheduled run) is held and sent when the person next writes. Default: no window.
   */
  readonly replyWindowMs?: number;
  /**
   * Outside the reply window, send what the provider still allows (a WhatsApp template) to invite the person to write. Called at
   * most once per held period (until the person writes again). A failure is reported and the reply stays held.
   */
  readonly invite?: (address: string) => Promise<void>;
}

/** Trusted host policy: the conversation this sender talks to, or null to refuse. The address is not an identity proof
 * beyond what the adapter verified; the host owns allow-lists, agents and conversation creation. */
export type ChannelRoute = (message: ChannelMessage) => Promise<Conversation | null>;

export interface ChannelGatewayOptions {
  readonly harness: Harness;
  readonly context: Context;
  readonly adapters: readonly ChannelAdapter[];
  readonly route: ChannelRoute;
  /**
   * Host policy for a message the gateway has classified as NEW input (never an answer to an open question, never a duplicate):
   * `true` admits it; a string refuses it, is recorded as handled (a redelivery is a no-op) and is sent to the person as a notice
   * (a daily limit, for example, or the answer to a command the host handles itself without a model turn, given `text`). Called
   * before the input is written to the outbox or submitted; it must be idempotent on `requestId`.
   */
  /**
   * The conversation an owed reply's input is (re)submitted through, by ID: the host's admission path (for example `routeSubmissions`
   * with its quota and wake job), so a recovery after a failure or a restart obeys the same policy as the first attempt. Default: the
   * native conversation.
   */
  readonly conversation?: (conversationId: ConversationId) => Promise<Conversation | undefined>;
  readonly admitInput?: (input: { readonly conversation: Conversation; readonly requestId: string; readonly channel: string; readonly address: string; readonly text: string }) => Promise<true | string>;
  /** Delays between send attempts; the last failure is reported and the reply dropped. */
  readonly retryDelaysMs?: readonly number[];
  /** Observe refusals and failures. Messages carry no secrets; message text is not included. */
  readonly onEvent?: (event: ChannelEvent) => void;
  /**
   * Test-only boundary between a settled answer and its send: awaited before the reply leaves. Hosts wire it only behind a debug
   * switch (a restart proof holds it to stop the object after the answer and before delivery). A rejection leaves the reply owed.
   */
  /** The gateway clock (milliseconds, the same epoch as `ChannelMessage.receivedAt`). Default `Date.now`. */
  readonly now?: () => number;
  readonly beforeSend?: (target: { readonly channel: string; readonly address: string; readonly requestId: string }, reply: ChannelReply) => Promise<void>;
}

export type ChannelEvent =
  | { readonly kind: 'refused'; readonly channel: string; readonly messageId: string }
  | { readonly kind: 'duplicate'; readonly channel: string; readonly messageId: string }
  | { readonly kind: 'answered-question'; readonly channel: string; readonly callId: string }
  | { readonly kind: 'delivered'; readonly channel: string; readonly requestId: string; readonly reply: ChannelReply['kind'] }
  | { readonly kind: 'undeliverable'; readonly channel: string; readonly requestId: string; readonly reason: string }
  /** Outside the adapter's reply window: the reply (or a question) waits for the person's next message. `invited` when an invite went out. */
  | { readonly kind: 'held'; readonly channel: string; readonly requestId: string; readonly reply: ChannelReply['kind']; readonly invited: boolean };

export interface ChannelGateway {
  /** The Fetch handler for one adapter's webhook. */
  readonly handler: (channel: string) => (request: Request) => Promise<Response>;
  /** Resume delivery of every reply admitted before a restart. Call once after `harness.resume()`. */
  readonly start: () => Promise<void>;
  /**
   * Host-initiated input (a scheduled task): submit `text` to `conversation` under `requestId` and owe its reply to `address`,
   * exactly like an inbound message, without one. Idempotent on `requestId`: a repeated dispatch (a retried or re-run
   * callback) neither submits nor replies twice. Resolves once the input is durably admitted; the reply follows in the background.
   */
  readonly dispatch: (input: ChannelDispatch) => Promise<'admitted' | 'duplicate' | 'full'>;
  /** How many replies are still owed and sendable (admitted, not yet sent, not held for the reply window). A host keeps a wake-up scheduled while this is above zero. */
  readonly owed: () => Promise<number>;
  /** Whether an input `requestId` is still owed a reply (admitted to the outbox, not yet sent): its submission may still be recovered. */
  readonly pending: (requestId: string) => Promise<boolean>;
  /** Stop waiting and watching. Admitted work and undelivered replies stay durable for the next `start`. */
  readonly close: () => Promise<void>;
}

/** Input the host submits on its own (a scheduled task), answered on a channel like an inbound message. */
export interface ChannelDispatch {
  readonly channel: string;
  readonly address: string;
  /** The conversation to submit to, admitted through the host's own path (for example `routeSubmissions`). */
  readonly conversation: Conversation;
  /** Deterministic per occurrence, so a repeat is recognised. */
  readonly requestId: string;
  readonly text: string;
}

/** A pending channel reply: written before the input is submitted, removed after the reply is sent. */
type OutboxItem = {
  requestId: string; conversationId: ConversationId; channel: string; address: string; text: string;
  /** `ask_user` calls already sent to this address while this input's run was active. */
  asked: string[];
  /** Settled outside the reply window: waits for the person's next message (not counted by `owed`, not resumed by `start`). */
  held?: boolean;
};
/** Detach a document draft before its commit settles. */
const copy = (item: OutboxItem): OutboxItem => ({ ...item, asked: [...item.asked] });
/** A question not sent because the reply window was closed: sent when the person next writes, and never answered before that. */
type HeldQuestion = { requestId: string; conversationId: ConversationId; channel: string; address: string; question: { callId: string; prompt: string; options: string[]; allowFreeText: boolean } };
/**
 * `items`: owed replies. `answers`: message IDs handled as replies to questions, answered or refused (ambiguous, stale, not
 * accepted), recorded before the webhook is acknowledged, so a redelivery is a no-op and never a new prompt or a late answer
 * to another question. `bindings`: which question a reply message answers, written once before answering and never changed,
 * so a redelivered reply can only re-answer that same question. `handledAt`: when each answer or binding was recorded; both
 * are kept for `RETENTION_MS` by time, never pruned by count. `askedAt`: when the gateway first saw each open question
 * (`<conversation>:<callId>`), at or before it was sent to a channel.
 */
type OutboxDoc = { items: OutboxItem[]; answers: string[]; bindings?: Record<string, string>; handledAt?: Record<string, number>; askedAt?: Record<string, number>;
  /** Provider time of each address's latest inbound message (`<channel>:<address>`), for the reply window. */
  lastInbound?: Record<string, number>;
  /** When each address was last sent an invite (`<channel>:<address>`): one invite per held period. */
  invited?: Record<string, number>;
  /** Questions held for the reply window, by `<conversation>:<callId>`. */
  heldQuestions?: Record<string, HeldQuestion>;
};
const Outbox = defineDoc<OutboxDoc>({ kind: 'boring.channels.outbox', version: 1, scope: 'session', initial: () => ({ items: [], answers: [], bindings: {} }) });
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A message whose provider time is older than this is never handled as new (Meta stops redelivering after about 7 days).
 * Records of handled replies are kept one day longer, so a redelivery young enough to be handled always finds its record.
 */
const MAX_MESSAGE_AGE_MS = 7 * DAY_MS;
const RETENTION_MS = MAX_MESSAGE_AGE_MS + DAY_MS;
/** Provider times have one-second resolution and come from another clock: a reply this close to its question still counts. */
const CLOCK_SKEW_MS = 5000;
const askedKey = (conversationId: ConversationId, callId: string) => `${String(conversationId)}:${callId}`;
const addressKey = (channel: string, address: string) => `${channel}:${address}`;

/** Drop answers, bindings and question times older than `RETENTION_MS`. Records written before `handledAt` existed start now. */
function prune(outbox: OutboxDoc, now: number): void {
  const cutoff = now - RETENTION_MS;
  outbox.handledAt ??= {};
  const handledAt = outbox.handledAt;
  const live = (id: string) => (handledAt[id] ??= now) >= cutoff;
  const answers = outbox.answers.filter(live);
  if (answers.length !== outbox.answers.length) outbox.answers.splice(0, outbox.answers.length, ...answers);
  outbox.bindings ??= {};
  const bindings = outbox.bindings;
  for (const id of Object.keys(bindings)) if (!live(id)) delete bindings[id];
  const kept = new Set(outbox.answers);
  for (const id of Object.keys(handledAt)) if (!kept.has(id) && !(id in bindings)) delete handledAt[id];
  outbox.askedAt ??= {};
  const askedAt = outbox.askedAt;
  for (const [key, at] of Object.entries(askedAt)) if (!(at >= cutoff)) delete askedAt[key];
}

/** Record when the gateway first saw each question (never moved later), and return those times by `callId`. */
function noteAsked(outbox: OutboxDoc, conversationId: ConversationId, questions: readonly PendingQuestion[], now: number): Record<string, number> {
  outbox.askedAt ??= {};
  const askedAt = outbox.askedAt;
  return Object.fromEntries(questions.map(question => [question.callId, askedAt[askedKey(conversationId, question.callId)] ??= now]));
}
const STALE_BUTTON = 'That button is out of date; tap the one on the latest question.';

const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const reply = (status: number, body: Record<string, unknown>): Response => Response.json({ schema: CHANNELS.schema, version: CHANNELS.version, ...body }, { status, headers });

type AcceptResult = 'admitted' | 'answered' | 'duplicate' | 'refused' | 'full';

/** The native request ID of a channel message. Pi deduplicates inputs on it per conversation. */
export const channelRequestId = (message: Pick<ChannelMessage, 'channel' | 'messageId'>): string => `channel:${message.channel}:${message.messageId}`;

export interface PendingQuestion { /** Assistant-entry-bound question ID. */ readonly callId: string; readonly prompt: string; readonly options: readonly string[]; readonly allowFreeText: boolean }

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The summary a call gated by `requireApproval` published while it waits for a decision (`pi.live` tool slot details). */
function awaitingApproval(live: unknown, callId: string): string | undefined {
  const tools = object(live)?.['tools'];
  const slot = Array.isArray(tools) ? tools.map(object).find(item => item?.['callId'] === callId) : undefined;
  const record = object(object(slot?.['details'])?.[APPROVAL_DETAILS]);
  return typeof record?.['summary'] === 'string' && record['decision'] === undefined ? record['summary'] : undefined;
}

/**
 * Questions of the active transcript that have no tool result yet, oldest first: `ask_user` calls and, when the
 * conversation's `pi.live` document is given, calls gated by `requireApproval` that wait for Approve or Deny (asked with
 * the same question mechanism, so the same answer path resolves them).
 */
export function pendingQuestions(entries: readonly EntryRecord[], live?: unknown): PendingQuestion[] {
  const pending = new Map<string, PendingQuestion>();
  for (const entry of entries) for (const message of entry.model ?? []) {
    if (message.role === 'toolResult') pending.delete(message.toolCallId);
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      if (part.name !== ASK_USER_TOOL) {
        const summary = live === undefined ? undefined : awaitingApproval(live, part.id);
        // The prompt `requireApproval` stores with its question.
        if (summary !== undefined) pending.set(part.id, { callId: askUserQuestionId(entry.id, part.id), prompt: `Allow ${part.name}? ${summary}`.slice(0, 1000), options: [APPROVE, DENY], allowFreeText: false });
        continue;
      }
      const args = part.arguments as { question?: unknown; options?: unknown; allowFreeText?: unknown };
      if (typeof args.question !== 'string') continue;
      const options = Array.isArray(args.options) ? args.options.filter((option): option is string => typeof option === 'string') : [];
      pending.set(part.id, { callId: askUserQuestionId(entry.id, part.id), prompt: args.question, options, allowFreeText: args.allowFreeText === true });
    }
  }
  return [...pending.values()];
}

/** Every pending question of a conversation, read from one view (entries and `pi.live`). */
async function openQuestions(conversation: Conversation, context: Context): Promise<PendingQuestion[]> {
  const watch = await conversation.watch(context);
  try { return pendingQuestions(watch.value.entries, watch.value.docs['pi.live']); } finally { await watch.stop(); }
}

/** A typed reply to a question: an exact option, its 1-based number, or free text. */
export function questionAnswer(question: PendingQuestion, text: string): string {
  const trimmed = text.trim();
  const exact = question.options.find(option => option.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact;
  const index = /^\d{1,2}$/.test(trimmed) ? Number(trimmed) - 1 : -1;
  return index >= 0 && index < question.options.length ? question.options[index]! : trimmed;
}

/** The visible text of the assistant message that answered a submission. */
function answerText(entry: EntryRecord | undefined): string {
  return (entry?.model ?? []).flatMap(message => message.role === 'assistant' ? message.content : [])
    .flatMap(part => part.type === 'text' ? [part.text] : []).join('\n\n').trim();
}

function settledReply(record: SettledSubmissionRecord, entry: EntryRecord | undefined): ChannelReply {
  if (record.status === 'done') {
    const markdown = answerText(entry);
    return markdown ? { kind: 'answer', markdown } : { kind: 'notice', text: 'Done.' };
  }
  return { kind: 'notice', text: record.reason === 'aborted' ? 'The request was stopped before an answer.' : 'The agent could not answer this message.' };
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * Connect channel adapters to native conversations. It adds no queue, scheduler or second session store: Pi admits,
 * deduplicates and orders the input; the only durable addition is the session document of replies still owed.
 * Delivery is at least once: a crash between sending and recording repeats that reply.
 */
export function createChannelGateway(options: ChannelGatewayOptions): ChannelGateway {
  const { harness, route } = options;
  const adapters = new Map(options.adapters.map(adapter => [adapter.id, adapter]));
  if (adapters.size !== options.adapters.length) throw new Error('Channel adapter IDs must be unique');
  const retryDelays = options.retryDelaysMs ?? [1000, 4000, 15_000, 60_000];
  const now = options.now ?? Date.now;
  const emit = (event: ChannelEvent) => { try { options.onEvent?.(event); } catch { /* observers never break delivery */ } };
  const closing = new AbortController();
  const context = withAbortSignal(closing.signal, options.context);
  const delivering = new Map<string, Promise<void>>();
  const watchers = new Map<string, { readonly run: Promise<void>; readonly stop: () => void }>();
  const pendingConversation = new Map<string, string>();
  /** Messages being accepted in this process: a concurrent copy of one (a provider retry racing the first) waits for it. */
  const accepting = new Map<string, Promise<AcceptResult>>();
  /** Held questions being sent by a `release` in this process: another release never sends one twice. */
  const releasing = new Set<string>();

  async function send(item: Pick<OutboxItem, 'channel' | 'address' | 'requestId'>, message: ChannelReply): Promise<boolean> {
    const adapter = adapters.get(item.channel);
    if (!adapter) { emit({ kind: 'undeliverable', channel: item.channel, requestId: item.requestId, reason: 'unknown-channel' }); return false; }
    for (let attempt = 0; ; attempt += 1) {
      try { await adapter.send(item.address, message); emit({ kind: 'delivered', channel: item.channel, requestId: item.requestId, reply: message.kind }); return true; }
      catch (error) {
        const retryable = (error as { retryable?: unknown } | null)?.retryable !== false;
        if (!retryable || attempt >= retryDelays.length || closing.signal.aborted) {
          if (!closing.signal.aborted) emit({ kind: 'undeliverable', channel: item.channel, requestId: item.requestId, reason: error instanceof Error ? error.message.slice(0, 200) : 'send-failed' });
          return false;
        }
        await sleep(retryDelays[attempt]!, closing.signal);
      }
    }
  }

  /** Whether a free-form message may go to this address now: inside the adapter's reply window. No inbound message on record: closed. */
  function windowOpen(outbox: OutboxDoc, channel: string, address: string): boolean {
    const window = adapters.get(channel)?.replyWindowMs;
    if (window === undefined) return true;
    const last = outbox.lastInbound?.[addressKey(channel, address)];
    return last !== undefined && now() - last < window;
  }

  /** Inside a commit: claim this held period's one invite for an address (none sent since its last inbound message). */
  function claimInvite(outbox: OutboxDoc, channel: string, address: string): boolean {
    if (!adapters.get(channel)?.invite) return false;
    const key = addressKey(channel, address);
    const invited = outbox.invited?.[key];
    if (invited !== undefined && invited >= (outbox.lastInbound?.[key] ?? 0)) return false;
    outbox.invited ??= {};
    outbox.invited[key] = now();
    return true;
  }

  async function invite(channel: string, address: string, requestId: string): Promise<boolean> {
    try { await adapters.get(channel)!.invite!(address); return true; }
    catch (error) { emit({ kind: 'undeliverable', channel, requestId, reason: `invite failed: ${error instanceof Error ? error.message.slice(0, 180) : 'unknown'}` }); return false; }
  }

  /** Send each newly pending question of a run started by a channel message to that message's sender. */
  function watchQuestions(conversation: Conversation): void {
    const key = String(conversation.id);
    if (watchers.has(key) || closing.signal.aborted) return;
    let stop = () => {};
    const run = (async () => {
      const watch = await conversation.watch(context);
      stop = () => { void watch.stop(); };
      if (closing.signal.aborted) { await watch.stop(); return; }
      const seen = new Set<string>();
      let queue = Promise.resolve();
      // Sends are chained off the watch so a slow provider never holds native frames.
      const enqueue = async (view: ConversationView) => {
        const fresh = pendingQuestions(view.entries, view.docs['pi.live']).filter(question => !seen.has(question.callId));
        if (!fresh.length) return;
        for (const question of fresh) seen.add(question.callId);
        queue = queue.then(async () => {
          const { owed, held } = await conversation.commit(async tx => {
            const outbox = await tx.doc(Outbox);
            // First seen now, before any send: a reply can only answer a question asked before the reply was sent.
            noteAsked(outbox, conversation.id, fresh, now());
            const out: { item: OutboxItem; question: PendingQuestion }[] = [], held: { item: OutboxItem; question: PendingQuestion; invite: boolean }[] = [];
            for (const item of outbox.items.filter(item => String(item.conversationId) === key)) {
              // Only the input whose run is active asked it; a question of a browser-started run stays in the browser.
              if ((await tx.submissionByRequest(conversation.id, item.requestId))?.status !== 'placed') continue;
              for (const question of fresh) {
                if (item.asked.includes(question.callId)) continue;
                if (windowOpen(outbox, item.channel, item.address)) { out.push({ item: copy(item), question }); continue; }
                // Outside the reply window: kept until the person writes, and not answerable before it is sent.
                outbox.heldQuestions ??= {};
                outbox.heldQuestions[askedKey(conversation.id, question.callId)] = { requestId: item.requestId, conversationId: conversation.id, channel: item.channel, address: item.address, question: { ...question, options: [...question.options] } };
                held.push({ item: copy(item), question, invite: claimInvite(outbox, item.channel, item.address) });
              }
            }
            return { owed: out, held };
          }, context);
          for (const { item, invite: invited } of held) {
            emit({ kind: 'held', channel: item.channel, requestId: item.requestId, reply: 'question', invited: invited && await invite(item.channel, item.address, item.requestId) });
          }
          for (const { item, question } of owed) {
            if (closing.signal.aborted) return;
            if (!await send(item, { kind: 'question', ...question })) continue;
            // Sending cannot share the native commit. A crash before this acknowledgement may repeat the notification.
            await conversation.commit(async tx => {
              const outbox = await tx.doc(Outbox);
              const current = outbox.items.find(value => value.requestId === item.requestId);
              if (current && !current.asked.includes(question.callId)) current.asked.push(question.callId);
            }, context);
          }
        }).catch(() => undefined);
      };
      // The acquisition snapshot is separate from subsequent native watch updates.
      await enqueue(watch.value);
      watch.start(enqueue);
      await watch.closed;
    })().catch(() => undefined).finally(() => { if (watchers.get(key)?.run === run) watchers.delete(key); });
    // Stopping forgets the entry at once, so the next channel message starts a fresh watch.
    watchers.set(key, { run, stop: () => { if (watchers.get(key)?.run === run) watchers.delete(key); stop(); } });
  }

  /** End the question watch once this conversation owes no channel reply. */
  async function releaseWatch(conversationId: ConversationId): Promise<void> {
    const key = String(conversationId);
    const owed = await harness.commit(async tx => (await tx.doc(Outbox)).items.some(item => String(item.conversationId) === key), options.context);
    if (!owed && ![...pendingConversation.values()].includes(key)) watchers.get(key)?.stop();
  }

  const resolveConversation = (id: ConversationId): Promise<Conversation | undefined> =>
    options.conversation ? options.conversation(id) : harness.conversation(id, context).then(found => found ?? undefined);

  /** Submit (idempotently, through `requestId`), wait for the native answer, send it, and drop the owed reply. */
  function deliver(item: OutboxItem): Promise<void> {
    const existing = delivering.get(item.requestId);
    if (existing) return existing;
    const run = (async () => {
      const conversation = await resolveConversation(item.conversationId);
      if (!conversation) {
        await settle(item.requestId);
        emit({ kind: 'undeliverable', channel: item.channel, requestId: item.requestId, reason: 'conversation-missing' });
        return;
      }
      watchQuestions(conversation);
      const admitted = await conversation.submit({ type: 'input', requestId: item.requestId, content: item.text, whenBusy: 'followUp' }, context);
      // A host may admit through its own path (`routeSubmissions`), which returns only the ID: reacquire the native submission.
      const submission = typeof admitted.wait === 'function' ? admitted : await harness.submission(admitted.id, context);
      if (!submission) throw new Error('The submission was not recorded');
      const record = await submission.wait(context);
      const answer = record.status === 'done' ? record.answer : undefined;
      const entry = answer === undefined ? undefined : (await conversation.entries({ minEntryId: answer, maxEntryId: answer }, 1, undefined, context)).items[0];
      if (closing.signal.aborted) return;
      const settled = settledReply(record, entry);
      if (options.beforeSend) await options.beforeSend({ channel: item.channel, address: item.address, requestId: item.requestId }, settled);
      if (closing.signal.aborted) return;
      // Outside the reply window (a scheduled run's answer): hold it for the person's next message, in the same commit that read the window.
      const hold = await harness.commit(async tx => {
        const outbox = await tx.doc(Outbox);
        if (windowOpen(outbox, item.channel, item.address)) return undefined;
        const current = outbox.items.find(value => value.requestId === item.requestId);
        if (current) current.held = true;
        return { invite: claimInvite(outbox, item.channel, item.address) };
      }, context);
      if (hold) {
        emit({ kind: 'held', channel: item.channel, requestId: item.requestId, reply: settled.kind, invited: hold.invite && await invite(item.channel, item.address, item.requestId) });
        return;
      }
      await send(item, settled);
      await settle(item.requestId);
    })().catch(error => {
      // The reply stays owed; the next `start` (or a redelivered webhook) retries it.
      if (!closing.signal.aborted) emit({ kind: 'undeliverable', channel: item.channel, requestId: item.requestId, reason: error instanceof Error ? error.message.slice(0, 200) : 'delivery-failed' });
    }).finally(() => {
      delivering.delete(item.requestId); pendingConversation.delete(item.requestId);
      if (!closing.signal.aborted) void releaseWatch(item.conversationId).catch(() => undefined);
    });
    delivering.set(item.requestId, run); pendingConversation.set(item.requestId, String(item.conversationId));
    return run;
  }

  async function settle(requestId: string): Promise<void> {
    if (closing.signal.aborted) return;
    await harness.commit(async tx => {
      const outbox = await tx.doc(Outbox);
      const index = outbox.items.findIndex(item => item.requestId === requestId);
      if (index >= 0) outbox.items.splice(index, 1);
    }, options.context);
  }

  /**
   * The person wrote: send what was held for the reply window, replies first, then questions. A held question stays held (so
   * no reply answers it) until its send succeeded; then it is unheld and marked asked in one commit, so only a message sent
   * after that answers it. A failed send keeps it held for the next message.
   */
  async function release(channel: string, address: string): Promise<void> {
    const { items, questions } = await harness.commit(async tx => {
      const outbox = await tx.doc(Outbox);
      if (!windowOpen(outbox, channel, address)) return { items: [], questions: [] };
      const items = outbox.items.filter(item => item.held && item.channel === channel && item.address === address);
      for (const item of items) delete item.held;
      const questions = Object.entries(outbox.heldQuestions ?? {}).filter(([key, held]) => held.channel === channel && held.address === address && !releasing.has(key));
      return { items: items.map(copy), questions: questions.map(([key, held]) => ({ key, ...held, question: { ...held.question, options: [...held.question.options] } })) };
    }, context);
    // A delivery still finishing its hold is awaited first, so the released item is not mistaken for it.
    for (const item of items) void (delivering.get(item.requestId) ?? Promise.resolve()).then(() => deliver(item));
    for (const held of questions) {
      if (releasing.has(held.key)) continue;
      releasing.add(held.key);
      try {
        const conversation = await harness.conversation(held.conversationId, context);
        const stillOpen = conversation && (await openQuestions(conversation, context)).some(question => question.callId === held.question.callId);
        if (!conversation || !stillOpen) {
          // Answered or gone elsewhere (the browser, a stop): nothing to send.
          await harness.commit(async tx => { const outbox = await tx.doc(Outbox); if (outbox.heldQuestions) delete outbox.heldQuestions[held.key]; }, context);
          continue;
        }
        if (!await send(held, { kind: 'question', ...held.question })) continue;
        await conversation.commit(async tx => {
          const outbox = await tx.doc(Outbox);
          if (outbox.heldQuestions) delete outbox.heldQuestions[held.key];
          const current = outbox.items.find(value => value.requestId === held.requestId);
          if (current && !current.asked.includes(held.question.callId)) current.asked.push(held.question.callId);
          // Asked now: only a reply sent after this answers it.
          outbox.askedAt ??= {};
          outbox.askedAt[held.key] = now();
        }, context);
      } finally { releasing.delete(held.key); }
    }
  }

  /** `undefined`: new input. `null`: already handled. An item: admitted before and its reply still owed. */
  async function knownInput(conversation: Conversation, requestId: string): Promise<OutboxItem | null | undefined> {
    return conversation.commit(async tx => {
      const outbox = await tx.doc(Outbox);
      if (outbox.answers.includes(requestId)) return null;
      if (await tx.submissionByRequest(conversation.id, requestId) === undefined) return undefined;
      const owed = outbox.items.find(item => item.requestId === requestId);
      return owed ? copy(owed) : null;
    }, context);
  }

  /** Owe the reply (durably), then submit, then deliver in the background. */
  async function admit(conversation: Conversation, item: OutboxItem): Promise<'admitted' | 'full'> {
    const admitted = await conversation.commit(async tx => {
      const outbox = await tx.doc(Outbox);
      const owed = outbox.items.find(value => value.requestId === item.requestId);
      if (owed) return copy(owed);
      if (outbox.items.length >= CHANNELS.maxOutbox) return 'full' as const;
      outbox.items.push(copy(item));
      return copy(item);
    }, context);
    if (admitted === 'full') return 'full';
    // Submit before acknowledging so the input is in the native inbox. If this throws, the provider redelivers (or the host
    // dispatches again) and the owed reply above is found again; `start` also resubmits it after a restart.
    await conversation.submit({ type: 'input', requestId: item.requestId, content: item.text, whenBusy: 'followUp' }, context);
    void deliver(admitted);
    return 'admitted';
  }

  /** Admit one verified message. Resolves once it is durable, so the webhook may be acknowledged. */
  async function accept(adapter: ChannelAdapter, message: ChannelMessage): Promise<AcceptResult> {
    if (message.channel !== adapter.id || !message.address || !message.messageId) return 'refused';
    const key = channelRequestId(message);
    const running = accepting.get(key);
    if (running) {
      // A concurrent copy shares the first attempt's outcome: a failure (thrown) or backpressure stays unacknowledged for
      // both, so the provider retries; only a durably handled message makes this copy a duplicate.
      const first = await running;
      if (first !== 'admitted' && first !== 'answered' && first !== 'duplicate') return first;
      emit({ kind: 'duplicate', channel: message.channel, messageId: message.messageId });
      return 'duplicate';
    }
    const run = acceptOnce(adapter, message);
    accepting.set(key, run);
    let result: AcceptResult;
    try { result = await run; } finally { accepting.delete(key); }
    // The person wrote: whatever waited for the reply window goes now, whether or not this message itself was admitted as new
    // work (a capped sender, a refused or duplicate reply). `release` checks the window, which only a verified, routed message opens.
    void release(message.channel, message.address).catch(() => undefined);
    return result;
  }

  async function acceptOnce(adapter: ChannelAdapter, message: ChannelMessage): Promise<AcceptResult> {
    const conversation = await route(message);
    if (!conversation) { emit({ kind: 'refused', channel: message.channel, messageId: message.messageId }); return 'refused'; }
    const requestId = channelRequestId(message);
    const text = message.text.slice(0, CHANNELS.maxText);
    // A redelivered webhook: Pi already has this input. Make sure its reply is still being delivered.
    const known = await knownInput(conversation, requestId);
    if (known !== undefined) {
      if (known) void deliver(known);
      emit({ kind: 'duplicate', channel: message.channel, messageId: message.messageId });
      return 'duplicate';
    }
    // Older than any redelivery: its record may be gone, so it is never handled as a new message or a reply.
    const sentAt = message.receivedAt;
    if (!Number.isFinite(sentAt) || now() - sentAt > MAX_MESSAGE_AGE_MS) { emit({ kind: 'refused', channel: message.channel, messageId: message.messageId }); return 'refused'; }

    // A reply while the agent waits on `ask_user` (or on an approval) answers it; the run continues and its answer comes back as usual.
    // Which question: the one a tapped option names; a typed reply only when exactly one is open; a reply already bound (a
    // redelivery after a crash) only its bound question. Never "the newest", which could be another one than the person saw.
    // The reply window counts from the provider time of the person's latest message. Questions held for the window were never
    // sent, so this message cannot answer them.
    const pending = await openQuestions(conversation, context);
    const heldQuestions = await conversation.commit(async tx => {
      const outbox = await tx.doc(Outbox);
      // Assigned, then read back: the document draft records writes made through it.
      outbox.lastInbound ??= {};
      const key = addressKey(message.channel, message.address);
      if (!(outbox.lastInbound[key]! >= sentAt)) outbox.lastInbound[key] = sentAt;
      return Object.keys(outbox.heldQuestions ?? {});
    }, context);
    const open = pending.filter(question => !heldQuestions.includes(askedKey(conversation.id, question.callId)));
    const { bound, askedAt } = await conversation.commit(async tx => {
      const outbox = await tx.doc(Outbox);
      return { bound: outbox.bindings?.[requestId], askedAt: noteAsked(outbox, conversation.id, open, now()) };
    }, context);
    const wanted = bound ?? message.choice?.question;
    /** Record this reply as handled (durably, before the acknowledgement); only the first copy to record it sends `notice`. */
    const handled = async (notice?: string): Promise<AcceptResult> => {
      const first = await conversation.commit(async tx => {
        const outbox = await tx.doc(Outbox);
        if (outbox.answers.includes(requestId)) return false;
        const at = now();
        prune(outbox, at);
        outbox.answers.push(requestId);
        outbox.handledAt ??= {};
        outbox.handledAt[requestId] = at;
        return true;
      }, context);
      if (!first) { emit({ kind: 'duplicate', channel: message.channel, messageId: message.messageId }); return 'duplicate'; }
      if (notice) void send({ channel: message.channel, address: message.address, requestId }, { kind: 'notice', text: notice });
      return 'answered';
    };
    if (wanted !== undefined && !open.some(question => question.callId === wanted)) {
      return handled(bound !== undefined ? undefined : message.choice?.question === '' ? STALE_BUTTON : 'That question is no longer open.');
    }
    if (wanted === undefined && open.length > 1) return handled(`${open.length} questions are waiting for you. Tap the button under the one you mean.`);
    const candidate = wanted === undefined ? open[0] : open.find(item => item.callId === wanted);
    // Freshness, independent of how long records are kept: a reply sent before its question was asked answers nothing.
    if (candidate && bound === undefined && sentAt + CLOCK_SKEW_MS < (askedAt[candidate.callId] ?? Infinity)) {
      return handled('That message was sent before the question; reply again to answer it.');
    }
    if (candidate) {
      // Bind once: a binding already written (by an earlier or concurrent copy of this message) wins and is never replaced.
      const binding = await conversation.commit(async tx => {
        const outbox = await tx.doc(Outbox);
        outbox.bindings ??= {};
        const existing = outbox.bindings[requestId];
        if (existing !== undefined) return { callId: existing, fresh: false };
        const at = now();
        prune(outbox, at);
        outbox.bindings[requestId] = candidate.callId;
        outbox.handledAt ??= {};
        outbox.handledAt[requestId] = at;
        return { callId: candidate.callId, fresh: true };
      }, context);
      const question = open.find(item => item.callId === binding.callId);
      if (!question) return handled();
      const result = await answerUserQuestion(conversation, question.callId, message.choice ? message.choice.option : questionAnswer(question, text), context);
      if (result.kind === 'answered') {
        // The same answer again (a concurrent copy) is accepted by the question; only the first to record it reports it.
        if (await handled() === 'duplicate') return 'duplicate';
        emit({ kind: 'answered-question', channel: message.channel, callId: question.callId });
        return 'answered';
      }
      if (result.kind === 'denied') {
        // Recorded first, so a redelivery does not try again; the notice and the question go out in the background.
        if (await handled() === 'duplicate') return 'duplicate';
        const target = { channel: message.channel, address: message.address, requestId };
        void (async () => {
          await send(target, { kind: 'notice', text: result.reason ? `${result.reason}.` : 'That answer was not accepted.' });
          await send(target, { kind: 'question', ...question });
        })();
        return 'answered';
      }
      // Another copy of this message bound it first: whatever happened to the question, it is not a new message.
      if (!binding.fresh) return handled();
      // A cancelled or concurrently answered question: treat the text as a new message.
    }

    if (options.admitInput) {
      const verdict = await options.admitInput({ conversation, requestId, channel: message.channel, address: message.address, text });
      if (verdict !== true) return await handled(verdict) === 'duplicate' ? 'duplicate' : 'refused';
    }
    const admitted = await admit(conversation, { requestId, conversationId: conversation.id, channel: message.channel, address: message.address, text, asked: [] });
    if (admitted === 'full') return 'full';
    void adapter.received?.(message).catch(() => undefined);
    return 'admitted';
  }

  return {
    handler: channel => {
      const adapter = adapters.get(channel);
      if (!adapter) throw new Error(`Unknown channel adapter: ${channel}`);
      return async request => {
        if (closing.signal.aborted) return reply(503, { reason: 'closing' });
        let receipt: ChannelReceipt;
        try { receipt = await adapter.receive(request); }
        catch { return reply(400, { reason: 'invalid-request' }); }
        if (receipt.kind === 'response') return receipt.response;
        const results: string[] = [];
        try { for (const message of receipt.messages) results.push(await accept(adapter, message)); }
        // Not acknowledged: the provider redelivers, and `requestId` keeps the retry from running twice.
        catch { return reply(503, { reason: 'source-unavailable' }); }
        if (results.includes('full')) return reply(503, { reason: 'outbox-full' });
        return reply(200, { accepted: results.filter(result => result === 'admitted' || result === 'answered').length });
      };
    },
    dispatch: async ({ channel, address, conversation, requestId, text }) => {
      if (closing.signal.aborted) throw new Error('The channel gateway is closed');
      if (!adapters.has(channel)) throw new Error(`Unknown channel adapter: ${channel}`);
      // Dispatched before (a retried callback): never a second submission; make sure its reply is still on its way.
      const known = await knownInput(conversation, requestId);
      if (known !== undefined) { if (known && !known.held) void deliver(known); return 'duplicate'; }
      return admit(conversation, { requestId, conversationId: conversation.id, channel, address, text: text.slice(0, CHANNELS.maxText), asked: [] });
    },
    owed: async () => harness.commit(async tx => (await tx.doc(Outbox)).items.filter(item => !item.held).length, context),
    pending: async requestId => harness.commit(async tx => (await tx.doc(Outbox)).items.some(item => item.requestId === requestId), context),
    start: async () => {
      const items = await harness.commit(async tx => (await tx.doc(Outbox)).items.filter(item => !item.held).map(copy), context);
      for (const item of items) void deliver(item);
    },
    close: async () => {
      closing.abort();
      const watching = [...watchers.values()];
      for (const watcher of watching) watcher.stop();
      await Promise.allSettled([...delivering.values(), ...watching.map(watcher => watcher.run)]);
    },
  };
}
