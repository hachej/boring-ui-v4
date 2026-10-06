// The agent as a Durable Object: native Pi (pi-durable) on Cloudflare's PiHarness, the SAME standard agent the studio uses
// (examples/shared/standard-agent.mjs) installed through the registry seam, a workspace of files in the same object's SQLite (the
// SQLite backend of @boring/files, with just-bash and git over the same files, see workspace.mjs), and the library chat transport
// served from `fetch`. Workers give it no canvas editor, subagents or code sandbox, so those parts are simply not passed: the agent is
// told only about what it has, and the UI says which scenarios need more. The agent evolves itself (`.agent/` in its workspace), and
// the person approves every reload. Fictional content only.
import { DurableObject } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import { PiHarness } from 'agents/harness/pi';
import { createAI, CLOUDFLARE_PROVIDER_ID } from 'agents/models/pi-ai';
import { Harness, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { answerUserQuestion } from '@boring/agent/ask-user';
import { defineStandardAgent } from '../../shared/standard-agent.mjs';
import { EFFORTS, configureOffered, firstMessageTitle } from '../../shared/conversation-host.mjs';
import { createChatTransportHandler, routeSubmissions } from '@boring/agent/chat-transport';
import { durableObjectSqliteConnection } from '@boring/files/sqlite-durable-object';
import { openSqliteFileSystem } from '@boring/files/sqlite-filesystem';
import { createWorkspaceJournal } from '@boring/files/journal';
import { createWorkspaceProvider } from '@boring/files/workspace';
import { createResourceHandler } from '@boring/files/remote';
import { createOptChatMemory } from '@boring/agent/memory/optchat';
import { createGitTool } from '@boring/agent/git';
import { readFiles, shell, writeFiles } from '../../shared/workspace-tools.mjs';
import { WORKSPACE_NAME, WORKSPACE_PROVIDER, WORKSPACE_ROOT, openCloudflareWorkspace } from './workspace.mjs';
import { legacyArtifact, sharedNotesPath } from './legacy-storage.mjs';
import { approvedState, reloadCommand } from './self-evolution-store.mjs';
import { DAY, MAIN_OBJECT, VIEW_PATH, fileViewType, forwardedAccess, sessionLink, notFound, objectOf, renderView, sessionRevocation, signSession, signViewLink, verifyViewLink } from './view-links.mjs';
import { mediaTypeOf } from '../../studio/file-types.mjs';
import { CHATGPT_DEFAULT_MODEL, CHATGPT_PROVIDER_ID, chatGPTModels } from './chatgpt.mjs';
import { WHATSAPP_PATH, WhatsAppChannel, whatsAppSettings } from './whatsapp.mjs';
import { HubIdentityLink } from './hub.mjs';
import { createToolRouterSession } from './composio-session.mjs';
import { startCode } from './registry.mjs';
import { dailyTurns } from './signup.mjs';
import { MCP_CALLBACK_PATH, McpServices } from './mcp.mjs';
import { withoutMcpByDefault } from '@boring/agent/mcp';
import { debugHolds } from './debug-holds.mjs';
import { SCHEDULES, createScheduleExtension, describeWhen, fireSchedule, nextRun } from './schedules.mjs';
import { createCloudflareSchedules } from './schedules-cloudflare.mjs';

// Workers AI model with native tool calling, chosen by Cloudflare's own Pi example for agent work. The second is a cheaper, faster fallback.
export const MODELS = [
  { modelId: '@cf/moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  { modelId: '@cf/zai-org/glm-4.7-flash', label: 'GLM 4.7 Flash' },
];

// One person owns this object. The Worker has already checked the bearer token; the agent acts in the same scope under its own principal.
const OWNER = { scopeId: 'recipe', principalId: 'owner', initiatorId: 'owner' };
const AGENT_ACCESS = { scopeId: OWNER.scopeId, principalId: 'agent', initiatorId: OWNER.principalId };
const locator = path => ({ resource: { providerId: WORKSPACE_PROVIDER, path }, view: { kind: 'published' } });
/** The person's text command that applies `.agent/` at once (their own approval), without a model turn. */
export const RELOAD_COMMAND = '/reload';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
/** A workspace path from a request or a link: relative, no `..`, no empty part. */
const relativePath = path => typeof path === 'string' && path.length > 0 && path.length <= 512 && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..') ? path : undefined;

/**
 * The MCP configuration of a person's object: one Composio Tool Router session of their own (user_id = their object name), created on
 * first need (see composio-session.mjs) when COMPOSIO_API_KEY is set; nothing otherwise. The URL here is a placeholder resolved then.
 */
function personMcpEnv(env) {
  const servers = env.COMPOSIO_API_KEY ? [{ id: 'composio', url: 'https://backend.composio.dev/tool_router/pending', headers: { 'x-api-key': 'COMPOSIO_API_KEY' }, allow: 'all', approve: 'composio' }] : [];
  return { ...env, MCP_SERVERS: JSON.stringify(servers), MCP_USER_ID: undefined };
}

const today = () => new Date().toISOString().slice(0, 10);
/** Marks the admission error of a reached daily cap, so the web answer becomes a 429. */
const TURN_LIMIT = '[daily-turn-limit]';
/** Turn reservations, kept as long as a provider may redeliver an input (WhatsApp: about 7 days), plus a day. */
const TURNS = 'turn-reservations', TURN_KEEP_MS = 8 * 86_400_000;
/** A reservation younger than this may still be on its way to Pi: reconciliation leaves it alone. */
const TURN_GRACE_MS = 120_000;

export class Assistant extends DurableObject {
  /**
   * The object's name is its person (`getByName`, see signup.mjs): 'main' is the owner's (ChatGPT when configured, MCP_SERVERS, the
   * WHATSAPP_ALLOWED numbers, no turn cap); any other is a signed-up person's (Workers AI, their own Composio session, their own linked
   * number, SIGNUP_DAILY_TURNS a day).
   */
  name = this.ctx.id.name ?? '';
  // Only the object addressed exactly as 'main' is the owner's: an object whose name the runtime does not expose is never the owner.
  owner = this.name === MAIN_OBJECT;
  ai = createAI({ binding: this.env.AI });
  registry = createRegistry();
  // The workspace (workspace.mjs): files in this object's SQLite, next to Pi's own `pi_*` tables, served to the viewers, `present` and
  // the shared notes by one provider (a save and its receipt commit in one `transactionSync`); Pi's file tools, bash and git work on
  // the same rows. Data of the earlier layout is moved in here once, when the object first opens with this code.
  workspace = openCloudflareWorkspace({ storage: this.ctx.storage, context });
  files = this.workspace.files;
  // The shared document: notes.md, or where the move from the earlier layout placed the published notes (legacy-storage.mjs).
  notes = locator(sharedNotesPath(this.workspace.connection));
  approved = approvedState(this.workspace.connection, this.workspace);
  // With the Worker secret OPENAI_API_KEY or CHATGPT_CREDENTIAL the agent uses OpenAI (see chatgpt.mjs); otherwise Workers AI.
  // Only the owner's object uses the owner's ChatGPT credential or OpenAI key.
  chatgpt = this.owner && (this.env.OPENAI_API_KEY || this.env.CHATGPT_CREDENTIAL) ? { provider: CHATGPT_PROVIDER_ID, modelId: this.env.CHATGPT_MODEL || CHATGPT_DEFAULT_MODEL } : undefined;
  /** The git tool resolves the repository when it runs, after the workspace has opened. */
  gitRepository = new Proxy({}, { get: (_, key) => async (...args) => (await this.workspace.repository()).repository[key](...args) });
  /** A tool that makes a link to the web workspace on this conversation with one thing open (see view-links.mjs). It only names what exists. */
  shareLink = defineTool({
    name: 'share_link',
    description: 'Make a link the person can open (on their phone or a computer) to work on something you made: a file in your workspace (path relative to it; what you presented is a file too) or the shared document (notes: true). The link opens the editable web workspace on this same conversation: the item open in its editor next to this chat, so the person can change it and you see their saved changes in your workspace. The link expires in 7 days. When you create or change something the person should see or edit, especially on WhatsApp, call this and include the link in your reply.',
    parameters: Type.Object({ file: Type.Optional(Type.String({ minLength: 1 })), notes: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    replay: 'safe',
    execute: async (args, api) => {
      const target = args.file ? { kind: 'file', path: args.file.replace(/^\/workspace\//, '') } : args.notes ? { kind: 'notes' } : undefined;
      if (!target) return { isError: true, content: [{ type: 'text', text: 'Give file or notes: true.' }] };
      const item = await this.#viewItem(target);
      if (!item) return { isError: true, content: [{ type: 'text', text: 'Nothing to show there: check the file path.' }] };
      const origin = this.#origin ?? await this.ctx.storage.get('public-origin');
      if (!origin || !this.env.ACCESS_TOKEN) return { isError: true, content: [{ type: 'text', text: 'Links are not available on this deployment.' }] };
      // The link names the conversation it was made in (the WhatsApp one, when asked there): the page opens on it.
      const conversation = api?.conversationId === undefined ? {} : { conversation: String(api.conversationId) };
      return { content: [{ type: 'text', text: `${origin}${VIEW_PATH}${await signViewLink(this.env.ACCESS_TOKEN, { ...target, ...conversation, object: this.name })}` }] };
    },
  });
  // Scheduled tasks (schedules.mjs): agents' Scheduler on this object's Lifecycle (installed below) stores and wakes them; a due one
  // is submitted to its conversation like a message, and on WhatsApp its answer is delivered like a reply (see #fire).
  timeZone = this.env.SCHEDULE_TIMEZONE || SCHEDULES.defaultTimeZone;
  schedules = createCloudflareSchedules({ onDue: (record, due) => this.#fire(record, due) });
  scheduleTools = createScheduleExtension({ backend: this.schedules.backend, timeZone: this.timeZone, approver: () => OWNER.principalId });
  standard = defineStandardAgent({
    id: 'standard-cloudflare', model: this.chatgpt ?? { provider: CLOUDFLARE_PROVIDER_ID, modelId: MODELS[0].modelId },
    files: this.files, access: AGENT_ACCESS, cwd: WORKSPACE_ROOT, root: WORKSPACE_ROOT,
    // Self-evolution: this object's `.agent/` lives in its own workspace and agent-written tools run in its just-bash, like bash. The
    // person approves every reload (the approval question, on the web or as WhatsApp buttons); only approved state takes effect.
    selfEvolving: { workspace: WORKSPACE_NAME, approval: this.approved }, notes: this.notes.resource.path,
    parts: [
      { capabilities: ['workspace'], extensions: [readFiles, writeFiles] },
      { capabilities: ['shell'], extensions: [shell] },
      { capabilities: ['git'], extensions: [defineExtension({ name: 'cloudflare.git', tools: [createGitTool(this.gitRepository)] })] },
      { capabilities: ['links'], tools: [this.shareLink] },
      { capabilities: ['schedules'], extensions: [this.scheduleTools] },
    ],
  });
  agent = this.standard.agent;
  /** The native Harness once PiHarness has opened it (OptChat reads it lazily). */
  #pi;
  // OptChat memory (one endless conversation, older turns summarized into a tree the agent can zoom into). Installed for every
  // conversation, selected for WhatsApp ones. Summaries come from a cheaper model of the same provider (OPTCHAT_MODEL overrides).
  memory = createOptChatMemory({
    harness: () => { if (!this.#pi) throw new Error('The harness is not open yet'); return this.#pi; },
    context, agentName: 'the assistant',
    summarizer: { model: this.chatgpt ? { provider: CHATGPT_PROVIDER_ID, modelId: this.env.OPTCHAT_MODEL || 'gpt-5.4-mini' } : { provider: CLOUDFLARE_PROVIDER_ID, modelId: MODELS[1].modelId } },
    onError: error => console.warn('optchat summary failed', String(error?.message ?? error).slice(0, 200)),
  });
  /** Conversation id → the selection applied since this object started (see `#select`). */
  #selected = new Map();
  // MCP servers from MCP_SERVERS (see mcp.mjs): Cloudflare's MCPClientManager on this object's Lifecycle, one native extension per
  // server. Only conversations the owner granted select them (WhatsApp conversations, and web ones created with `services: true`).
  mcp = new McpServices({ env: this.owner ? this.env : personMcpEnv(this.env), storage: this.ctx.storage, registry: this.registry, granted: id => this.#granted(id),
    origin: async () => this.#origin ?? await this.ctx.storage.get('public-origin'), start: () => this.lifecycle.start(),
    ...(this.owner ? {} : { resolveUrl: () => this.#composioUrl() }) });
  // Restart-proof barriers (debug-holds.mjs): undefined unless ENABLE_DEBUG_ROUTES=1, and then nothing below is wrapped or hooked.
  holds = debugHolds(this.env);
  #wrap = provider => this.holds ? this.holds.provider(provider) : provider;
  harness = new PiHarness({
    harness: async ({ storage, context: opening }) => {
      this.agent.install(this.registry);
      // What the person last approved in `.agent/`, so it survives the object's restarts (and nothing unapproved takes effect).
      await this.agent.restore();
      this.registry.install(this.memory.extension);
      // MCP extensions from the tool lists cached at their last connection, so a replayed call finds its tool before reconnecting.
      await this.mcp.restore();
      const models = this.chatgpt ? chatGPTModels(this.ctx.storage, this.env, this.#wrap) : createModels();
      models.setProvider(this.#wrap(this.ai.provider));
      // A conversation that never chose its extensions gets every installed one except MCP servers: those need a grant.
      const pi = await Harness.open(storage, { models, registry: this.registry, settings: withoutMcpByDefault(this.registry), env: async () => (await this.workspace.repository()).env }, opening);
      this.#pi = pi;
      // Before PiHarness resumes interrupted work: every conversation selects the current agent's extensions (the file guard among
      // them), keeping its OptChat memory and MCP grants, so nothing resumes with a selection from an earlier version of the agent.
      const kept = (await this.ctx.storage.get('conversations')) ?? { ids: [] };
      for (const id of kept.ids) { const found = await pi.conversation(id, opening); if (found) await this.#applySelection(found); }
      return pi;
    },
    defaults: { model: this.ai(MODELS[0].modelId) },
  });
  // The MCP manager starts first: it restores its servers before the harness resumes work that may call them. Installed only when configured.
  // The Scheduler shares the Lifecycle's one alarm and job loop; its callbacks wait for the harness when they need it.
  lifecycle = (this.mcp.configured ? Lifecycle.install(this).use(this.mcp.manager) : Lifecycle.install(this)).use(this.harness).use(this.schedules.scheduler);
  // The hub's copy of a linked WhatsApp number, sent best effort with retries (hub.mjs).
  hubLink = new HubIdentityLink({ env: this.env, storage: this.ctx.storage, crash: name => this.#crash(name) });
  #hubLinkInstalled = this.lifecycle.use(this.hubLink);
  // WhatsApp when its secrets are set: admitted senders (#admitted), one conversation each (see whatsapp.mjs and examples/whatsapp).
  whatsapp = whatsAppSettings(this.env);
  channel = this.whatsapp ? new WhatsAppChannel({ settings: this.whatsapp, pi: () => this.harness.pi(), context,
    conversationFor: address => this.#conversationFor(address), admit: message => this.#admitMessage(message),
    // The person's `/reload` is answered here without a model turn (their own command is their approval); everything else takes a turn.
    admitInput: async ({ conversation, requestId, text }) => text?.trim() === RELOAD_COMMAND ? await this.#reloadCommand(requestId) : await this.#reserveTurn(conversation.id, requestId) || this.#limitText(),
    // Recovery of an owed input goes through the same admission path (its reservation, the wake job) as the first attempt.
    resolve: async id => { await this.#open(); const found = this.#conversations.get(String(id)); return found ? this.#viaHarness(found) : undefined; }, ...(this.holds ? { beforeSend: this.holds.beforeSend } : {}) }) : undefined;
  #channelInstalled = this.channel ? this.lifecycle.use(this.channel) : undefined;

  /** Conversation ids in creation order and the time of each one's last activity, kept in this object's key-value storage. */
  #state;
  /** Changes whenever the object restarts: the in-memory instance is new, the SQLite state is not. */
  #instance = crypto.randomUUID();
  #conversations = new Map();
  #opening;

  async #open() {
    this.#opening ??= (async () => {
      const pi = await this.harness.pi();
      this.#state = (await this.ctx.storage.get('conversations')) ?? { ids: [], activity: {} };
      for (const id of this.#state.ids) { const found = await pi.conversation(id, context); if (found) this.#conversations.set(String(id), found); }
      if (this.#conversations.size === 0) await this.#create(pi);
      // Connect MCP servers in the background, so the first granted turn finds them ready.
      // A person's Composio session is created on first need (their first granted turn), not when the object opens.
      if (this.mcp.configured && this.owner) void this.mcp.ready().catch(error => console.warn('mcp start failed', String(error?.message ?? error).slice(0, 200)));
      return pi;
    })();
    try { return await this.#opening; } catch (error) { this.#opening = undefined; throw error; }
  }

  async #create(pi) {
    const conversation = await this.agent.createConversation(pi, context);
    this.#conversations.set(String(conversation.id), conversation);
    this.#state.ids.push(Number(conversation.id));
    await this.#touch(conversation.id);
    return conversation;
  }

  async #touch(id) {
    this.#state.activity[String(id)] = Date.now();
    await this.ctx.storage.put('conversations', this.#state);
  }

  /**
   * The person's `/reload`: the same reload as the agent's tool, applied at once (the person asking is the approval) and saved as the
   * approved state. Returns the report the person gets back.
   */
  async #reloadCommand(requestId) {
    try { return await reloadCommand({ approved: this.approved, agent: this.agent, env: async () => (await this.workspace.repository()).env, requestId, context }); }
    catch (error) { console.error('reload failed', String(error?.message ?? error).slice(0, 200)); return 'The reload failed; nothing was changed.'; }
  }


  #origin;
  /** A link target as a workspace file: an artifact named by a link made before artifacts became files is the file it was moved to. */
  #linkTarget(target) {
    if (target.kind !== 'artifact') return target;
    const found = typeof target.id === 'string' ? legacyArtifact(this.workspace.connection, target.id) : undefined;
    return found ? { kind: 'file', path: found.path } : undefined;
  }

  /**
   * `POST /api/session { link }`: a valid view link becomes a session token for the page (scope owner, 24 hours or
   * SESSION_TTL_SECONDS when shorter), with what to open: the link's conversation (when it still exists) and its target.
   */
  async #session(request) {
    const { link, status } = await sessionLink(request);
    if (status) return json({ reason: status === 413 ? 'too-large' : status === 415 ? 'unsupported-media-type' : 'invalid-request' }, status);
    const target = typeof link === 'string' && this.env.ACCESS_TOKEN ? await verifyViewLink(this.env.ACCESS_TOKEN, link) : undefined;
    if (!target) return json({ reason: 'link-invalid' }, 401);
    await this.#open();
    const conversation = target.conversation !== undefined && this.#conversations.has(String(target.conversation)) ? Number(target.conversation) : undefined;
    const ttl = Math.min(DAY, Number(this.env.SESSION_TTL_SECONDS) > 0 ? Number(this.env.SESSION_TTL_SECONDS) : DAY);
    // A link reaches only the object that made it (the Worker routed it here by the same field).
    if (objectOf(target) !== this.name) return json({ reason: 'link-invalid' }, 401);
    const token = await signSession(this.env.ACCESS_TOKEN, { conversation, object: this.name }, ttl);
    let opens;
    const item = this.#linkTarget(target);
    if (item?.kind === 'file') opens = { kind: 'file', path: item.path };
    else if (item?.kind === 'notes') opens = { kind: 'notes' };
    return json({ token, expiresAt: (Math.floor(Date.now() / 1000) + ttl) * 1000, ...(conversation === undefined ? {} : { conversation }), ...(opens ? { opens } : {}) });
  }

  /** What a view link shows: the item's title, how to render it and its text, or undefined when it does not exist. */
  async #viewItem(link) {
    const target = this.#linkTarget(link);
    const read = async path => {
      const result = await this.files.read({ target: locator(path), revision: { kind: 'latest' } }, AGENT_ACCESS);
      if (result.kind !== 'available') return undefined;
      try { return new TextDecoder('utf-8', { fatal: true }).decode(result.snapshot.bytes); } catch { return undefined; }
    };
    if (target?.kind === 'notes') { const text = await read(this.notes.resource.path); return text === undefined ? undefined : { title: 'Shared document', type: 'markdown', text }; }
    if (target?.kind === 'file') {
      const path = relativePath(target.path);
      const text = path === undefined ? undefined : await read(path);
      return text === undefined ? undefined : { title: path, type: fileViewType(path), text, language: path.split('.').pop() };
    }
    return undefined;
  }

  /** Models the person may pick: the ChatGPT one when configured, then Workers AI. */
  #offered() {
    return [...(this.chatgpt ? [{ ...this.chatgpt, label: `OpenAI ${this.chatgpt.modelId}` }] : []), ...MODELS.map(model => ({ provider: CLOUDFLARE_PROVIDER_ID, ...model }))];
  }

  /** The conversation of one WhatsApp sender, created on their first message; its admissions keep the object's wake job. */
  async #conversationFor(address) {
    const pi = await this.#open();
    const bindings = (await this.ctx.storage.get('whatsapp-bindings')) ?? {};
    let conversation = bindings[address] === undefined ? undefined : this.#conversations.get(String(bindings[address]));
    if (!conversation) {
      conversation = await this.#create(pi);
      await this.ctx.storage.put('whatsapp-bindings', { ...bindings, [address]: Number(conversation.id) });
    }
    // WhatsApp conversations are endless (OptChat) and belong to the owner (granted the MCP servers).
    await this.#select(conversation);
    await this.#touch(conversation.id);
    return this.#viaHarness(conversation);
  }

  /** The WhatsApp sender a conversation belongs to, or undefined for a web conversation. */
  async #addressOf(id) {
    const bindings = (await this.ctx.storage.get('whatsapp-bindings')) ?? {};
    return Object.keys(bindings).find(address => String(bindings[address]) === String(id));
  }

  /**
   * One due schedule occurrence: the instruction goes into the schedule's conversation through the same admission path as a
   * message (PiHarness keeps the wake job), under `schedule:<id>:<occurrence>` so a retried callback submits once. In a WhatsApp
   * conversation the answer is owed to the sender like a reply (held outside the 24-hour window); in a web one it is just there.
   */
  async #fire(record, due) {
    await fireSchedule(record, due, async ({ conversation: id, requestId, text }) => {
      await this.#open();
      const conversation = this.#conversations.get(String(id));
      if (!conversation) { console.warn(`schedule ${record.id}: its conversation no longer exists`); return; }
      await this.#select(conversation);
      const address = await this.#addressOf(id), routed = this.#viaHarness(conversation);
      if (!await this.#reserveTurn(id, requestId)) { console.warn(`schedule ${record.id}: skipped, the daily turn limit is reached`); return; }
      if (address && this.channel && await this.#allowedSender(address)) await this.channel.dispatch({ address, conversation: routed, requestId, text });
      else await routed.submit({ type: 'input', requestId, content: text, whenBusy: 'followUp' }, context);
    });
  }

  /** Conversation ids the owner granted the MCP servers to from the web (`POST /api/conversations { services: true }`). */
  async #grants() { return new Set((await this.ctx.storage.get('mcp-grants')) ?? []); }

  /** Whether a conversation is a WhatsApp sender's. */
  async #whatsApp(id) { return Object.values((await this.ctx.storage.get('whatsapp-bindings')) ?? {}).some(bound => String(bound) === String(id)); }

  /** Host policy, also checked inside every MCP call: WhatsApp conversations of allowed senders and web conversations granted by the owner. */
  async #granted(id) {
    if (!this.mcp.configured) return false;
    return await this.#whatsApp(id) || (await this.#grants()).has(Number(id));
  }

  /**
   * Select a conversation's extensions explicitly: the agent's own, OptChat for WhatsApp ones, and the MCP servers when granted. Selection is
   * by name and stored natively, so it survives restarts; it is applied once per object start (the native configure is safe to repeat).
   * A granted turn waits (bounded) for the servers to connect, so the first one already sees their tools. Every conversation gets the
   * current definition, so one created by an earlier version of the agent (other extension names, native instructions that named tools
   * which are gone) follows this one: the host's instructions now live in the agent's own extension, so a stored copy is cleared.
   */
  async #select(conversation) {
    const memory = await this.#whatsApp(conversation.id), granted = await this.#granted(conversation.id);
    if (granted) await this.mcp.ready({ timeout: 8_000 }).catch(error => console.warn('mcp not ready', String(error?.message ?? error).slice(0, 200)));
    if (this.#selected.get(String(conversation.id)) === `${memory}:${granted}`) return;
    await this.#applySelection(conversation);
  }

  /** The current selection, natively: the agent's extensions, OptChat when it is a WhatsApp conversation, the MCP servers when granted. */
  async #applySelection(conversation) {
    const memory = await this.#whatsApp(conversation.id), granted = await this.#granted(conversation.id);
    await conversation.configure({ extensions: [...this.agent.extensions, ...(memory ? [this.memory.extension] : []), ...(granted ? this.mcp.extensions() : [])], instructions: null }, context);
    this.#selected.set(String(conversation.id), `${memory}:${granted}`);
  }

  /**
   * Submissions go through `PiHarness` so the object keeps a wake job (an evicted object restarts from its alarm). This is the one
   * admission boundary of every input (web, WhatsApp, schedules): each one reserves a turn of the day, keyed by its request ID.
   */
  #viaHarness(conversation) {
    return routeSubmissions(conversation, async draft => {
      if (!await this.#reserveTurn(conversation.id, draft.requestId)) throw new Error(`${TURN_LIMIT} ${this.#limitText()}`);
      await this.#crash('after-reserve');
      let submitted;
      try { submitted = await this.harness.submit(draft.content, { session: String(conversation.id), operationId: draft.requestId, ...(draft.whenBusy ? { whenBusy: draft.whenBusy } : {}) }); }
      catch (error) { await this.#settleTurn(conversation.id, draft.requestId, false).catch(() => undefined); throw error; }
      await this.#settleTurn(conversation.id, draft.requestId, true);
      return submitted;
    });
  }

  // ---- People (see signup.mjs): who may write to this object, its own Composio session, its daily turns. ----

  /**
   * A WhatsApp ID (digits) this object may talk to now: the owner's allow-list on 'main', or a number the registry says this object
   * owns (checked on every inbound message and before every scheduled reply, so the registry alone decides).
   */
  async #allowedSender(address) {
    if (this.owner && this.whatsapp?.allowed.includes(address)) return true;
    if (!this.env.REGISTRY) return false;
    return (await this.env.REGISTRY.getByName('registry').phone(`+${address}`))?.object === this.name;
  }

  /** Host policy for one WhatsApp message: its sender, and not a START code (the Worker handles those). The turn cap is `admitInput`. */
  async #admitMessage(message) {
    if (!await this.#allowedSender(message.address)) return false;
    return !startCode(message.text);
  }

  #limitText() { return `You've reached today's limit of ${dailyTurns(this.env)} messages. Your agent will be back tomorrow.`; }

  /**
   * Reserve a turn for input `requestId` of `conversationId` (none counted on 'main'). One at a time, and idempotent across days: an
   * input keeps its reservation (counted against the day it was first reserved) for as long as a provider may redeliver it, so a retry
   * of yesterday's input never takes today's quota. False when today's cap is reached, after reconciling: a reservation whose
   * submission never reached Pi (a crash or a failed submit) is released.
   */
  #reserveTurn(conversationId, requestId) {
    if (this.owner) return Promise.resolve(true);
    return this.#turnsDo(async () => {
      const key = `${String(conversationId)}:${requestId}`, now = Date.now(), day = today();
      const all = (await this.ctx.storage.get(TURNS)) ?? {};
      if (all[key]) return true;
      for (const [old, entry] of Object.entries(all)) if (now - entry.at > TURN_KEEP_MS) delete all[old];
      const usedToday = () => Object.values(all).filter(entry => entry.day === day).length;
      if (usedToday() >= dailyTurns(this.env)) await this.#reconcileTurns(all, TURN_GRACE_MS);
      if (usedToday() >= dailyTurns(this.env)) { await this.ctx.storage.put(TURNS, all); return false; }
      all[key] = { day, at: now };
      await this.ctx.storage.put(TURNS, all);
      return true;
    });
  }
  #turns = Promise.resolve();
  #turnsDo(work) { const run = this.#turns.then(work); this.#turns = run.catch(() => undefined); return run; }

  /**
   * Whether input `requestId` of `conversationId` is (or will be) a turn: Pi holds its submission, or a channel still owes it (its
   * outbox entry is recovered by the gateway through the same admission path, which reuses this reservation).
   */
  async #submitted(conversationId, requestId) {
    await this.#open();
    const conversation = this.#conversations.get(String(conversationId));
    if (conversation && await conversation.commit(tx => tx.submissionByRequest(conversation.id, requestId), context)) return true;
    return Boolean(this.channel && await this.channel.pending(requestId));
  }

  /** Today's reservations not known to have landed and older than `grace`: kept when Pi has them, released otherwise. Mutates `all`. */
  async #reconcileTurns(all, grace) {
    const now = Date.now(), day = today();
    for (const [key, entry] of Object.entries(all)) {
      if (entry.landed || entry.day !== day || now - entry.at < grace) continue;
      const at = key.indexOf(':');
      if (await this.#submitted(key.slice(0, at), key.slice(at + 1))) all[key] = { ...entry, landed: true }; else delete all[key];
    }
  }

  /** After a submission: keep its reservation (landed) when Pi has it, release it when it never got there. */
  #settleTurn(conversationId, requestId, landed) {
    if (this.owner) return Promise.resolve();
    return this.#turnsDo(async () => {
      const key = `${String(conversationId)}:${requestId}`, all = (await this.ctx.storage.get(TURNS)) ?? {};
      if (!all[key]) return;
      if (landed || await this.#submitted(conversationId, requestId)) all[key] = { ...all[key], landed: true }; else delete all[key];
      await this.ctx.storage.put(TURNS, all);
    });
  }

  /** Debug-only crash points (ENABLE_DEBUG_ROUTES=1): an armed name aborts the object when reached, once. */
  #crashpoints = new Set();
  async #crash(name) {
    if (!this.#crashpoints.delete(name)) return;
    // The writes before the crash point are durable (as if the process died right after they committed), then the object dies.
    await this.ctx.storage.sync();
    this.ctx.abort(`crashpoint ${name}`);
    await new Promise(() => {});
  }

  /** This person's Composio Tool Router session URL, created once (user_id = this object's name) and kept in this object. */
  #composio;
  #composioUrl() {
    this.#composio ??= (async () => {
      const kept = await this.ctx.storage.get('composio-session');
      if (kept?.url) return kept.url;
      const session = await createToolRouterSession({ apiKey: this.env.COMPOSIO_API_KEY, userId: this.name,
        toolkits: (this.env.COMPOSIO_TOOLKITS ?? '').split(',').map(item => item.trim()).filter(Boolean), ...(this.env.COMPOSIO_API_ORIGIN ? { origin: this.env.COMPOSIO_API_ORIGIN } : {}) });
      await this.ctx.storage.put('composio-session', session);
      return session.url;
    })();
    this.#composio.catch(() => { this.#composio = undefined; });
    return this.#composio;
  }

  /**
   * RPC from the Worker's sign-in callback: keep this person's hub grant (access token, expiry, refresh token, resource) in this
   * object, for the hub link once their START arrives (hub.mjs). Never in the registry, never in the browser.
   */
  async holdHubGrant(grant) {
    await this.hubLink.hold(grant);
    // A number adopted here but not yet linked at the hub (an earlier attempt given up) is tried again with this fresh grant.
    if (await this.hubLink.rearm((await this.ctx.storage.get('person'))?.phones ?? [])) { await this.lifecycle.start(); await this.hubLink.ensureJob(); }
  }

  /**
   * RPC from the Worker when a person's START code was redeemed: link `phone` (E.164) to this object, and owe the hub that link
   * (with the grant held from their sign-in). Idempotent; `{ added }` says whether the number is new here.
   */
  async adopt({ phone, subject }) {
    const person = (await this.ctx.storage.get('person')) ?? { subject, phones: [] };
    const added = !person.phones.includes(phone);
    // The phone and the obligation to tell the hub land in one write: an interrupted adoption never keeps one without the other.
    if (added) await this.ctx.storage.put({ person: { ...person, subject, phones: [...person.phones, phone] }, ...await this.hubLink.obligation(phone) });
    await this.#crash('after-adopt-write');
    await this.lifecycle.start();
    // Replayed or repeated (a START for a number already adopted but not linked at the hub): a pending obligation gets its job.
    await this.hubLink.rearm([phone]);
    await this.hubLink.ensureJob();
    return { added };
  }

  #configure(conversation, change) {
    return configureOffered(conversation, change, context, model => this.#offered().some(item => item.modelId === model.modelId && item.provider === model.provider));
  }

  #chat = createChatTransportHandler({ authenticate: async request => {
    await this.#open();
    const conversation = this.#conversations.get(new URL(request.url).searchParams.get('conversation') ?? '');
    if (!conversation) return null;
    if (request.method === 'POST') { await this.#touch(conversation.id); await this.#select(conversation); }
    // A session token's access ends at its expiry: an open watch closes then, and later effects are refused.
    const revoked = sessionRevocation(request);
    return { conversation: this.#viaHarness(conversation), context, ...(revoked ? { revoked } : {}), abortSubmission: async id => (await this.harness.pi()).abortSubmission(id, context, conversation.id), answer: (callId, answer) => answerUserQuestion(conversation, callId, answer),
      configure: change => this.#configure(conversation, change) };
  } });

  /**
   * Proof that a multi-file save is atomic in this object's SQLite: a second workspace (`atomicity-proof`) whose connection fails the
   * second history insert, after both files, the receipt and the first history row were written in the same transaction. Everything
   * must roll back.
   */
  async #atomicityProof() {
    const base = durableObjectSqliteConnection(this.ctx.storage);
    let injected = 0, staged, histories = 0;
    const counts = () => base.get(`SELECT (SELECT count(*) FROM boring_workspace_files WHERE workspace = 'atomicity-proof' AND kind = 'file') AS documents,
      (SELECT count(*) FROM boring_history) AS versions, (SELECT count(*) FROM boring_operations) AS operations, (SELECT count(*) FROM boring_changes) AS changes`);
    const faulty = { ...base, run: (sql, ...params) => {
      if (sql.startsWith('INSERT INTO boring_history') && ++histories === 2) { injected++; staged = counts(); throw new Error('injected fault after the file, receipt and history rows were written'); }
      return base.run(sql, ...params);
    } };
    const fs = openSqliteFileSystem({ connection: faulty, workspace: 'atomicity-proof', cwd: WORKSPACE_ROOT });
    const proof = createWorkspaceProvider({ identity: { providerId: WORKSPACE_PROVIDER, instanceId: 'atomicity-proof', incarnation: fs.incarnation, viewId: 'published' }, fs, journal: createWorkspaceJournal(faulty) });
    const before = counts();
    let outcome;
    try {
      outcome = await proof.publication.publish({ operationId: `atomicity-${crypto.randomUUID()}`, atomicity: 'all-or-nothing',
        changes: ['proof/one.md', 'proof/two.md'].map(path => ({ kind: 'create', target: locator(path), expected: { kind: 'absent' }, bytes: new TextEncoder().encode(path), mediaType: 'text/markdown' })) },
      { scopeId: 'atomicity-proof', principalId: 'proof', initiatorId: 'proof' });
    } catch (error) { outcome = `threw: ${error.message}`; }
    const after = counts();
    return { injected, staged, outcome, before, after, rolledBack: JSON.stringify(before) === JSON.stringify(after) };
  }

  // The editors (file viewer, artifact panel, the shared document) read and save workspace files through the one provider.
  #resources = createResourceHandler({ authenticate: async () => OWNER, reader: this.files, publisher: this.files.publication, lookup: this.files.reconciliation });

  /** Called by the Worker after it has checked the bearer token or session, with the verified access in trusted headers. */
  async fetch(request) {
    const url = new URL(request.url);
    // The public origin, for links the agent sends (the Worker forwards the original URL).
    if (this.#origin !== url.origin) { this.#origin = url.origin; await this.ctx.storage.put('public-origin', url.origin); }
    try {
      // A view link's read-only preview (`?raw=1`, forwarded by the Worker): signed, no bearer token (see view-links.mjs).
      if (url.pathname.startsWith(VIEW_PATH) && request.method === 'GET') {
        const target = this.env.ACCESS_TOKEN ? await verifyViewLink(this.env.ACCESS_TOKEN, url.pathname.slice(VIEW_PATH.length)) : undefined;
        const item = target && objectOf(target) === this.name ? await this.#viewItem(target) : undefined;
        return item ? renderView(item) : notFound();
      }
      // This class defines `fetch`, so Lifecycle leaves it alone and capability request hooks do not run on their own: route the
      // webhook to the WhatsApp capability and the OAuth callback to the MCP manager here, after starting the lifecycle (which also resumes replies owed before a restart).
      // The MCP OAuth callback (forwarded by the Worker without the bearer token): the manager verifies its state and stores the tokens.
      if (url.pathname === MCP_CALLBACK_PATH && request.method === 'GET') {
        if (!this.mcp.configured) return json({ reason: 'not-found' }, 404);
        await this.lifecycle.start();
        return (await this.mcp.onRequest(request)) ?? json({ reason: 'not-found' }, 404);
      }
      if (url.pathname === WHATSAPP_PATH) {
        if (!this.channel) return json({ reason: 'not-found' }, 404);
        await this.lifecycle.start();
        return (await this.channel.onRequest({ request })) ?? json({ reason: 'not-found' }, 404);
      }
      // A view link exchanged for a session token (the Worker forwards this route without a bearer: the link is the credential).
      if (url.pathname === '/api/session' && request.method === 'POST') return await this.#session(request);
      // Everything below needs the access the Worker verified and forwarded: the operator, the person, or a view link's session.
      const access = forwardedAccess(request);
      if (access.scope === 'none') return json({ reason: 'authentication-required' }, 401);
      // A view link's session reaches only the link's conversation (read it, chat in it) and the item editors; not other
      // conversations, not new ones, not the schedules of others.
      const linked = access.scope === 'link' ? access.conversation ?? '' : undefined;
      if (linked !== undefined && ['/api/chat', '/api/memory', '/api/services'].includes(url.pathname) && url.searchParams.get('conversation') !== linked) return json({ reason: 'not-authorized' }, 403);
      if (linked !== undefined && url.pathname === '/api/conversations' && request.method !== 'GET') return json({ reason: 'not-authorized' }, 403);
      if (url.pathname === '/api/chat') {
        const response = await this.#chat(request);
        // A person's daily turn cap, refused at the admission boundary (#viaHarness): a 429 with the friendly text, not an outage.
        if (response.status === 503) {
          const reason = String((await response.clone().json().catch(() => ({})))?.reason ?? '');
          if (reason.includes(TURN_LIMIT)) return json({ reason: this.#limitText() }, 429);
        }
        return response;
      }
      if (url.pathname === '/api/resources') return await this.#resources(request);
      // The retained revisions of a workspace file with their save times, newest first: the panel's version menu.
      if (url.pathname === '/api/history' && request.method === 'GET') return json({ saves: this.files.saves(url.searchParams.get('path') ?? '') });
      await this.#open();
      if (url.pathname === '/api/agent' && request.method === 'GET') {
        return json({ id: this.agent.id, title: 'Assistant', skills: this.agent.skills, models: this.#offered(), efforts: EFFORTS, notes: this.notes, access: access.scope,
          // The variant as the shared scenario list sees it: what this deployment gives the one standard agent.
          variant: { id: 'cloudflare', title: 'Cloudflare', description: 'A Durable Object on Workers: its own files with bash and git in its SQLite workspace, presented files, the shared document and questions.', capabilities: this.standard.capabilities },
          identity: { runtimeId: 'cloudflare-recipe', ...OWNER }, instance: this.#instance });
      }
      // The agent's workspace, read-only: every file path, or one file's text (binary files report their size only).
      if (url.pathname === '/api/files' && request.method === 'GET') return json({ root: this.workspace.root, files: await this.workspace.list() });
      if (url.pathname === '/api/file' && request.method === 'GET') {
        const relative = relativePath((url.searchParams.get('path') ?? '').replace(/^\/workspace\//, '')); // the file viewer names files `/workspace/<path>`
        if (relative === undefined) return json({ reason: 'invalid-path' }, 400);
        const read = await this.workspace.fs.readBinaryFile(`${this.workspace.root}/${relative}`, context);
        if (!read.ok) return json({ reason: 'not-found' }, 404);
        const bytes = read.value;
        // `raw=1`: the bytes themselves (images and PDFs in the file viewer), never rendered by this origin.
        if (url.searchParams.get('raw') === '1') return new Response(bytes, { headers: { 'content-type': mediaTypeOf(relative), 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
        let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = undefined; }
        return json({ path: relative, size: bytes.byteLength, ...(text === undefined ? {} : { text }) });
      }
      // OptChat state of one conversation: the view the next request would carry and the summarizer's progress.
      if (url.pathname === '/api/memory' && request.method === 'GET') {
        const id = url.searchParams.get('conversation') ?? '';
        if (!this.#conversations.has(id)) return json({ reason: 'not-found' }, 404);
        const conversation = this.#conversations.get(id);
        // The native configuration says whether OptChat shapes this conversation's requests (`lastRequest` is per object instance).
        const selected = (await conversation.agent(context)).extensions.some(extension => extension.name === this.memory.extension.name);
        return json({ selected, stats: await this.memory.stats(Number(id)) });
      }
      // Scheduled tasks, for the web view: each record with its next run (owner bearer or session, checked by the Worker).
      if (url.pathname === '/api/schedules' && request.method === 'GET') {
        const now = Date.now();
        const schedules = (await this.schedules.backend.list()).filter(record => linked === undefined || String(record.conversation) === linked).map(record => {
          const next = nextRun(record, now);
          return { ...record, description: describeWhen(record.when, record.timezone, now), nextRun: next === undefined ? null : new Date(next).toISOString() };
        });
        return json({ timezone: this.timeZone, limits: { maxSchedules: SCHEDULES.maxSchedules, minIntervalMinutes: SCHEDULES.minIntervalMinutes }, schedules });
      }
      if (url.pathname === '/api/conversations' && request.method === 'GET') {
        const items = await Promise.all(this.#state.ids.filter(id => this.#conversations.has(String(id)) && (linked === undefined || String(id) === linked)).map(async id => ({ id, title: (await firstMessageTitle(this.#conversations.get(String(id)), context)) ?? null, updatedAt: this.#state.activity[String(id)] ?? null })));
        return json({ conversations: items });
      }
      // `{ services: true }` grants the new conversation the configured MCP servers; without it the conversation never sees them.
      if (url.pathname === '/api/conversations' && request.method === 'POST') {
        const body = await request.text();
        let services = false;
        try { services = body.length <= 1024 && body ? JSON.parse(body)?.services === true : false; } catch { return json({ reason: 'invalid-request' }, 400); }
        const conversation = await this.#create(await this.harness.pi());
        if (services && this.mcp.configured) { await this.ctx.storage.put('mcp-grants', [...await this.#grants(), Number(conversation.id)]); await this.#select(conversation); }
        return json({ conversationId: Number(conversation.id) });
      }
      // MCP servers: each one's connection state and tools, and whether one conversation is granted them and selects them.
      if (url.pathname === '/api/services' && request.method === 'GET') {
        const id = url.searchParams.get('conversation');
        const conversation = id === null ? undefined : this.#conversations.get(id);
        if (id !== null && !conversation) return json({ reason: 'not-found' }, 404);
        if (url.searchParams.get('wait') === '1') await this.mcp.ready().catch(() => undefined);
        return json({ servers: this.mcp.status(), ...(conversation ? { granted: await this.#granted(conversation.id), selected: (await conversation.agent(context)).extensions.map(extension => extension.name) } : {}) });
      }
      // Proof routes exist only when the operator sets ENABLE_DEBUG_ROUTES=1 (for example `wrangler dev --var ENABLE_DEBUG_ROUTES:1`); a deployment answers 404.
      if (this.env.ENABLE_DEBUG_ROUTES === '1') {
        if (url.pathname === '/api/debug/atomicity' && request.method === 'POST') return json(await this.#atomicityProof());
        // Crash points for the signup journey: arm one ({ name }: after-reserve, after-adopt-write, after-grant-refresh), read the turn
        // reservations (`reconcile=1` reconciles them now, without the grace period).
        if (url.pathname === '/api/debug/crashpoints' && request.method === 'POST') { const { name } = await request.json().catch(() => ({})); this.#crashpoints.add(String(name)); return json({ armed: [...this.#crashpoints] }); }
        if (url.pathname === '/api/debug/turns' && request.method === 'GET') {
          const all = await this.#turnsDo(async () => {
            const kept = (await this.ctx.storage.get(TURNS)) ?? {};
            if (url.searchParams.get('reconcile') === '1') { await this.#reconcileTurns(kept, 0); await this.ctx.storage.put(TURNS, kept); }
            return kept;
          });
          return json({ day: today(), reservations: all });
        }
        // Restart proof: abort this object's isolate. State lives in SQLite; the next request (or the wake alarm) starts it again.
        if (url.pathname === '/api/debug/restart' && request.method === 'POST') { this.ctx.abort('restart requested for the recovery proof'); return json({ restarting: true }); }
        // Restart-proof barriers: arm a one-shot hold ({ boundary: 'generation' | 'delivery', match }), list armed and waiting holds, release.
        if (url.pathname === '/api/debug/holds' && request.method === 'GET') return json(this.holds.state());
        if (url.pathname === '/api/debug/holds' && request.method === 'POST') return this.holds.arm(await request.json().catch(() => ({}))) ? json(this.holds.state()) : json({ reason: 'invalid-request' }, 400);
        if (url.pathname === '/api/debug/holds/release' && request.method === 'POST') { this.holds.release((await request.json().catch(() => ({}))).match); return json(this.holds.state()); }
      }
      return json({ reason: 'not-found' }, 404);
    } catch (error) {
      console.error('request failed', String(error?.stack ?? error));
      return json({ reason: 'internal-error' }, 500);
    }
  }
}
