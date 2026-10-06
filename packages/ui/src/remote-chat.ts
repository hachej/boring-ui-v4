import type { Context } from '@earendil-works/chord';
import { applyImmutable } from '@earendil-works/chord/delta';
import type { ConversationView, ConversationWatch, Cursor, InputSubmissionDraft, Page, EntryRecord, SettledSubmissionRecord, SubmissionRecord, WatchEnd } from '@earendil-works/pi-durable';
import type { ChatConversation } from './native-chat.js';

/** Browser client for the `@boring/agent/chat-transport` handler. Bundles only Chord's standalone delta replay, no Pi runtime. */
export interface RemoteChatOptions {
  /** Handler URL. Existing query parameters (for example a conversation selector) are preserved. */
  readonly endpoint: string | URL;
  /** The host adds credentials here. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Submission status poll interval for `Submission.wait`. */
  readonly pollMs?: number;
  /**
   * Release the watch stream while the page is hidden and reopen it when visible again (default true; only effective where
   * `document.visibilityState` exists). Browsers cap concurrent HTTP/1.1 connections per host, so one idle stream per background tab
   * can starve every other request. A reopened watch begins with a complete view, so nothing is lost. Submissions, answers and
   * running turns are separate requests and are never affected. Pass false to keep the stream open while hidden.
   */
  readonly pauseWhenHidden?: boolean;
}

export interface RemoteChat {
  /** The members of the native conversation the chat controller uses, served by the remote host. Nothing else is pretended. */
  readonly conversation: ChatConversation;
  /** Placeholder for the controller's Context argument. The server owns the real native Context. */
  readonly context: Context;
  /** Answer an assistant-entry-bound question ID from the transcript. The host authenticates and resolves it. */
  readonly answer: (callId: string, answer: string) => Promise<{ kind: 'answered' } | { kind: 'denied' | 'conflict' | 'unknown-question'; reason?: string }>;
  /** Ask the host to change this conversation's model or thinking level. The host decides: a refusal carries its reason. */
  readonly configure: (change: { readonly model?: { readonly provider: string; readonly modelId: string }; readonly thinkingLevel?: string }) => Promise<{ kind: 'configured' } | { kind: 'refused'; reason?: string }>;
  /** Stop a watch that the controller never claimed. Safe to call at any time; the controller's own watch is its to stop. */
  readonly close: () => Promise<void>;
  /** Withdraw a queued message before it runs. `already_placed` and `settled` mean it was too late. */
  readonly withdraw: (submissionId: SubmissionRecord['id']) => Promise<'aborted' | 'already_placed' | 'settled'>;
}

type Ops = Parameters<typeof applyImmutable>[1];
type Frame = { readonly kind: 'view'; readonly view: ConversationView } | { readonly kind: 'ops'; readonly ops: Ops } | { readonly kind: 'end'; readonly reason: string };

async function reason(response: Response): Promise<string> {
  try { const value = await response.json() as { reason?: unknown }; if (typeof value.reason === 'string') return value.reason; } catch { /* fall through */ }
  return `status ${response.status}`;
}

/**
 * Connect a browser to one remote native conversation. Resolves after the first view so the conversation
 * identity is the server's. A dropped connection is presentation state: reconnect by connecting the controller again.
 */
export async function createRemoteChat(options: RemoteChatOptions): Promise<RemoteChat> {
  const base = new URL(options.endpoint, globalThis.location?.href);
  const send = options.fetch, pollMs = options.pollMs ?? 500;
  const url = (op: string, extra: Record<string, string> = {}) => {
    const target = new URL(base); target.searchParams.set('op', op);
    for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, value);
    return target;
  };
  async function call<T>(op: string, init: RequestInit = {}, extra: Record<string, string> = {}): Promise<T> {
    const response = await send(new Request(url(op, extra), init));
    if (!response.ok) throw new Error(`Remote chat ${op} failed: ${await reason(response)}`);
    return await response.json() as T;
  }
  const post = <T>(op: string, value: unknown) => call<T>(op, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const lookup = async (requestId: string) => (await call<{ record: SubmissionRecord | null }>('submission', {}, { requestId })).record ?? undefined;

  async function watch(): Promise<ConversationWatch> {
    const stopped = new AbortController();
    const response = await send(new Request(url('watch'), { signal: stopped.signal }));
    if (!response.ok || !response.body) throw new Error(`Remote chat watch failed: ${await reason(response)}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = '';
    async function next(): Promise<Frame | undefined> {
      for (;;) {
        const end = pending.indexOf('\n');
        if (end >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); return JSON.parse(line) as Frame; }
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        pending += chunk.value;
      }
    }
    const first = await next();
    if (first?.kind !== 'view') { stopped.abort(); throw new Error('Remote chat watch ended before its first view'); }
    let value = first.view, started = false, settle!: (end: WatchEnd) => void, ended: WatchEnd | undefined;
    const closed = new Promise<WatchEnd>(resolve => { settle = resolve; });
    const finish = (end: WatchEnd) => { if (!ended) { ended = end; stopped.abort(); settle(end); } };
    const handle: ConversationWatch = {
      get value() { return value; },
      closed,
      stop: async () => { finish({ reason: 'stopped' }); return closed; },
      start: listener => {
        if (started) throw new Error('Watch already started');
        started = true;
        void (async () => {
          try {
            for (;;) {
              const frame = await next();
              if (ended) return;
              // The stream ending without an end frame is a lost connection, not a native terminal state.
              if (!frame || frame.kind === 'end') return finish({ reason: frame?.reason === 'retired' ? 'retired' : frame?.reason === 'stopped' ? 'stopped' : 'session_closed' });
              // Native operation batches are replayed with the upstream delta implementation; a view frame resets the replica.
              value = frame.kind === 'view' ? frame.view : applyImmutable(value, frame.ops) as ConversationView;
              try { await listener(value, [], context); }
              catch (error) { return finish({ reason: 'listener_error', error: error instanceof Error ? error : new Error(String(error)) }); }
            }
          } catch (error) { if (!ended) finish({ reason: 'listener_error', error: error instanceof Error ? error : new Error(String(error)) }); }
        })();
      },
    };
    return handle;
  }

  const page = options.pauseWhenHidden === false ? undefined : (globalThis as { document?: Document }).document;
  const hidden = () => page?.visibilityState === 'hidden';

  /**
   * Wrap a watch so the stream can be released while the page is hidden. The wrapper stays open for the controller (it is not a
   * close), is re-filled with a complete view on resume, and ends only when stopped, lost, or a resume fails (then the controller's
   * normal reconnect applies).
   */
  function supervise(first: ConversationWatch): ConversationWatch {
    if (!page) return first;
    let current: ConversationWatch | undefined = first, last = first.value, listener: Parameters<ConversationWatch['start']>[0] | undefined;
    let ended: WatchEnd | undefined, settle!: (end: WatchEnd) => void, generation = 0;
    const closed = new Promise<WatchEnd>(resolve => { settle = resolve; });
    const finish = (end: WatchEnd) => {
      if (ended) return;
      ended = end; page.removeEventListener('visibilitychange', onVisibility); settle(end);
      const live = current; current = undefined; void live?.stop();
    };
    const forward = async (view: ConversationView) => { last = view; await listener!(view, [], context); };
    function attach(watch: ConversationWatch) {
      current = watch;
      void watch.closed.then(end => { if (current === watch) { current = undefined; finish(end); } });
      watch.start(async view => { if (current === watch) await forward(view); });
    }
    async function pause() {
      const live = current; if (!live || !listener) return;
      generation++; last = live.value; current = undefined; await live.stop();
    }
    async function resume() {
      if (current || ended || !listener) return;
      const mine = ++generation;
      try {
        const reopened = await watch();
        if (ended || mine !== generation || hidden()) { await reopened.stop(); return; }
        try { await forward(reopened.value); } catch (error) { await reopened.stop(); return finish({ reason: 'listener_error', error: error instanceof Error ? error : new Error(String(error)) }); }
        if (ended || mine !== generation) { await reopened.stop(); return; }
        attach(reopened);
      } catch { finish({ reason: 'session_closed' }); }
    }
    function onVisibility() { void (hidden() ? pause() : resume()); }
    page.addEventListener('visibilitychange', onVisibility);
    return {
      get value() { return current?.value ?? last; },
      closed,
      stop: async () => { finish({ reason: 'stopped' }); return closed; },
      start: next => {
        if (listener) throw new Error('Watch already started');
        listener = next;
        if (hidden()) void pause(); else attach(first);
      },
    };
  }

  // The first watch tells us the conversation identity. The controller's first `watch()` takes it over instead of opening a second one.
  let unclaimed: ConversationWatch | undefined = await watch();
  const id = unclaimed.value.conversation.id;

  const requests = new Map<SubmissionRecord['id'], string>();
  const withdraw = async (submissionId: SubmissionRecord['id'], requestId = requests.get(submissionId)) =>
    (await post<{ result: 'aborted' | 'already_placed' | 'settled' }>('withdraw', { submissionId, ...(requestId === undefined ? {} : { requestId }) })).result;
  const conversation: ChatConversation = {
    id,
    watch: async () => { const first = unclaimed; unclaimed = undefined; return supervise(first ?? await watch()); },
    submit: async (draft: InputSubmissionDraft) => {
      if (draft.type !== 'input' || !draft.requestId) throw new Error('Remote chat submits input drafts with a request ID');
      const requestId = draft.requestId;
      const { submissionId } = await post<{ submissionId: SubmissionRecord['id'] }>('submit', { requestId, content: draft.content, whenBusy: draft.whenBusy });
      requests.set(submissionId, requestId);
      const status = async () => { const record = await lookup(requestId); if (!record) throw new Error('Submission is unknown to the remote host'); return record; };
      return {
        id: submissionId, status,
        wait: async () => { for (;;) { const record = await status(); if (record.status === 'done' || record.status === 'unanswered') return record as SettledSubmissionRecord; await new Promise(resolve => setTimeout(resolve, pollMs)); } },
        abort: () => withdraw(submissionId, requestId),
      };
    },
    // The controller only reconciles a submission by request ID; no other transaction work crosses the wire.
    commit: async (change, _context) => change({ submissionByRequest: (_conversationId, requestId) => lookup(requestId) }),
    abort: async () => { await post('abort', {}); },
    entries: async (_query, limit, cursor: Cursor | undefined) =>
      (await call<{ page: Page<EntryRecord, Cursor> }>('entries', {}, { limit: String(limit), ...(cursor === undefined ? {} : { cursor: JSON.stringify(cursor) }) })).page,
  };
  const context = Object.freeze({}) as unknown as Context;
  const close = async () => { const first = unclaimed; unclaimed = undefined; await first?.stop(); };
  return { conversation, context, close, withdraw: id => withdraw(id),
    answer: (callId, answer) => post('answer', { callId, answer }), configure: change => post('configure', change) };
}
