// Studio host: ONE standard agent (examples/shared/standard-agent.mjs) on a durable native Harness, behind a real HTTP socket.
// What differs between deployments is infrastructure only, supplied by variants (./variants/*.mjs): the execution environment,
// where resources are stored, the models, and whether it can run at all. Scenarios (./scenarios/*.mjs) are data the browser lists
// and the journey executes. Sessions live in SQLite and survive a restart. Fictional content only; the bearer token is a local
// fixture, not an identity provider.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { EFFORTS, configureOffered } from '../shared/conversation-host.mjs';
import { sendWebResponse, webRequest } from '@boring/files/node-http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Harness, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { answerUserQuestion } from '@boring/agent/ask-user';
import { createGitTool } from '@boring/agent/git';
import { createChatTransportHandler } from '@boring/agent/chat-transport';
import { createConversations, createConversationsHandler } from '@boring/agent/conversations';
import { createMentionResolver, safeMentionPath } from '@boring/agent/mentions';
import { createMeter, createSqliteLedger } from '@boring/agent/metering';
import { openNodeConnection } from '@boring/files/sqlite';
import { createWorkspaceJournal } from '@boring/files/journal';
import { createWorkspaceProvider, isTemporary } from '@boring/files/workspace';
import { createResourceHandler } from '@boring/files/remote';
import { withSubmitFaults } from '@boring/testing/network';
import { defineStandardAgent } from '../shared/standard-agent.mjs';
import { createCanvasTools } from '../shared/canvas-tools.mjs';
import { runCodeTool } from '../shared/codemode-tools.mjs';
import { createSubagents } from '../shared/subagent-tools.mjs';
import { connectMcpTools } from '../shared/mcp-tools.mjs';
import { readFiles, shell, writeFiles } from '../shared/workspace-tools.mjs';
import { buildTailwind } from './tailwind.mjs';
import { loadVariants } from './variants/index.mjs';
import { describeScenario, loadScenarios } from './scenarios/index.mjs';
import { isBinaryKind, kindOf, mediaTypeOf } from './file-types.mjs';
import { startChannels, whatsAppFromEnv } from './channels.mjs';

const PROVIDERS = {
  openai: async () => (await import('@earendil-works/pi-ai/providers/openai')).openaiProvider(),
  anthropic: async () => (await import('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider(),
};
/** The models the composer offers; the last one is also what subagents run on. */
const DEFAULT_MODELS = {
  openai: [{ modelId: 'gpt-5-mini', label: 'GPT-5 mini' }, { modelId: 'gpt-5-nano', label: 'GPT-5 nano' }],
  anthropic: [{ modelId: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }],
};
const here = name => fileURLToPath(new URL(name, import.meta.url));
/** The workspace as the browser and the journeys see it, whatever directory a variant's environment really uses. */
const VIRTUAL_ROOT = '/workspace';
/**
 * Fictional credits of the variants that declare `credits: true` (local): every message holds `holdMicros` while it runs and is charged its
 * usage, priced by Pi's `calculateCost` from the model's rates with a 1.25 markup (@boring/agent/metering). One millionth is one micro.
 */
const CREDITS = { startMicros: 50_000_000, holdMicros: 20_000, markup: 1.25 };

export async function startStudio({ directory, port = 0, provider = process.env.STUDIO_PROVIDER ?? 'openai', models: modelOptions, modelsOverride, variants: only, token = randomUUID(), whatsapp = whatsAppFromEnv(),
  // The deterministic test layer (./scripted-model.mjs): chosen by the host process only, never by a request. Absent unless STUDIO_MODEL=scripted or the caller asks.
  scripted = process.env.STUDIO_MODEL === 'scripted',
  // Idle heartbeat of the chat watch stream (default 15 s). Behind a proxy or load balancer keep it under half the idle timeout.
  heartbeatMs = process.env.STUDIO_HEARTBEAT_MS ? Number(process.env.STUDIO_HEARTBEAT_MS) : undefined,
  // Test hook: the answer to a chat submit is held this long after the host handled it (the message is already recorded), like a slow
  // network. Also settable at run time through the returned `submitFaults` (journeys); `refuse` answers the next N submits with a refusal.
  submitDelayMs = Number(process.env.STUDIO_SUBMIT_DELAY_MS ?? 0) } = {}) {
  if (!directory) throw new Error('A data directory is required');
  mkdirSync(directory, { recursive: true });
  let models = modelsOverride, scriptMisses = [];
  if (scripted && !models) { provider = 'openai'; ({ models, misses: scriptMisses } = await (await import('./scripted-model.mjs')).createScriptedModels()); }
  if (!models) { models = createModels(); models.setProvider(await PROVIDERS[provider]()); }
  const offered = (modelOptions ?? DEFAULT_MODELS[provider] ?? []).map(model => ({ provider, ...model }));
  if (offered.length === 0) throw new Error(`No models are configured for provider ${provider}; pass { models: [{ modelId, label }] }`);

  const human = { scopeId: 'fictional-project', principalId: 'fictional-person', initiatorId: 'fictional-person' };
  const agentAccess = { scopeId: human.scopeId, principalId: 'fictional-agent', initiatorId: human.principalId };
  const hostInfo = { provider, context, directory, models: offered };
  let harness;
  const getHarness = () => { if (!harness) throw new Error('The harness is not open yet'); return harness; };
  const ok = result => { if (!result.ok) throw result.error; return result.value; };
  /** The text of a file, or `undefined` when it is binary: an image or PDF kind, a NUL byte, or bytes that are not UTF-8. */
  function decodeText(path, bytes) {
    if (isBinaryKind(path) || bytes.includes(0)) return undefined;
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; }
  }

  const readOf = (variant, path) => variant.files.read({ target: { resource: { providerId: 'workspace', path }, view: { kind: 'published' } }, revision: { kind: 'latest' } }, human);
  /** What `@path` mentions read: the person's view of the workspace through the variant's provider. */
  const mentionReader = files => async path => {
    if (!safeMentionPath(path)) return undefined;
    const read = await files.read({ target: { resource: { providerId: 'workspace', path }, view: { kind: 'published' } }, revision: { kind: 'latest' } }, human);
    if (read.kind !== 'available') return undefined;
    return read.snapshot.bytes.byteLength > 5_000_000 ? { size: read.snapshot.bytes.byteLength } : { size: read.snapshot.bytes.byteLength, bytes: read.snapshot.bytes };
  };
  /** Creates a file that must not exist yet, through the provider. `false` when it does. */
  async function createFile(variant, path, bytes) {
    const published = await variant.files.publication.publish({ operationId: randomUUID(), atomicity: 'all-or-nothing',
      changes: [{ kind: 'create', target: { resource: { providerId: 'workspace', path }, view: { kind: 'published' } }, expected: { kind: 'absent' }, bytes, mediaType: mediaTypeOf(path) }] }, human);
    if (published.kind === 'conflict') return false;
    if (published.kind !== 'committed') throw new Error(`The file could not be saved: ${published.reason ?? published.kind}`);
    return true;
  }

  // The workspace provider's journal (receipts, intents, retained versions) lives here, outside every workspace.
  const workspaceDb = openNodeConnection(join(directory, 'workspace.sqlite'));
  const journal = createWorkspaceJournal(workspaceDb);

  // ---- Variants: infrastructure only. An unavailable one stays in the list with the reason.
  const descriptors = await loadVariants(hostInfo, only);
  const variants = new Map();
  for (const descriptor of descriptors) {
    if (descriptor.available !== true) continue;
    const infra = await descriptor.open();
    const { env, root } = infra;
    const capabilities = new Set(descriptor.capabilities);
    // One workspace provider over the variant's environment: the one way to read a workspace file by revision and to write it
    // conditionally (viewers, saves, uploads, `present`, and the documents the agent and the person share: notes.md and board.tldraw).
    const files = createWorkspaceProvider({ identity: { providerId: 'workspace', instanceId: descriptor.id, incarnation: 'studio', viewId: 'published' }, fs: env, journal });
    const target = path => ({ resource: { providerId: 'workspace', path }, view: { kind: 'published' } });
    const canvasTarget = target('board.tldraw');
    const subagents = createSubagents({ harness: getHarness, context, childModel: { provider, modelId: offered.at(-1).modelId }, childExtensions: capabilities.has('workspace') ? [readFiles] : [] });
    const parts = [
      ...(capabilities.has('workspace') ? [{ capabilities: ['workspace'], extensions: [readFiles, writeFiles] }] : []),
      ...(capabilities.has('shell') ? [{ capabilities: ['shell', ...(capabilities.has('python') ? ['python'] : [])], extensions: [shell] }] : []),
      ...(infra.repository ? [{ capabilities: ['git'], extensions: [defineExtension({ name: 'studio.git', tools: [createGitTool(infra.repository)] })] }] : []),
      { capabilities: ['canvas'], tools: createCanvasTools({ files, path: 'board.tldraw', access: agentAccess, namespace: `studio-${descriptor.id}-canvas-v1` }) },
      { capabilities: ['subagents'], tools: subagents.tools, extensions: subagents.extensions },
      { capabilities: ['codemode'], tools: [runCodeTool] },
    ];
    // MCP servers the variant names (off unless it does): their allowed tools become native tools of the agent (../shared/mcp-tools.mjs).
    const mcp = [];
    for (const server of descriptor.mcp?.servers ?? []) mcp.push(await connectMcpTools({ ...server, transport: server.transport() }));
    if (mcp.length) parts.push({ capabilities: ['mcp'], tools: mcp.flatMap(connection => connection.tools) });
    const { agent, capabilities: all } = defineStandardAgent({ id: `standard-${descriptor.id}`, model: { provider, modelId: offered[0].modelId }, cwd: infra.cwd ?? root,
      root, files, access: agentAccess, parts, ...(descriptor.selfEvolving ? { selfEvolving: descriptor.id } : {}) });
    // What the agent has, plus what the environment itself offers beyond tools (for example a remote sandbox's status tab).
    const variant = { id: descriptor.id, descriptor, infra, mcp, env, root, agent, capabilities: [...new Set([...all, ...descriptor.capabilities])], files, subagents, notes: target('notes.md'), canvas: canvasTarget,
      resourceHandler: createResourceHandler({ authenticate: async request => authenticated(request) ? human : null, reader: files, publisher: files.publication, lookup: files.reconciliation }),
      mentions: createMentionResolver({ read: mentionReader(files) }) };
    variants.set(descriptor.id, variant);
  }
  if (variants.size === 0) throw new Error('No variant is available');
  const scenarios = await loadScenarios();
  const entries = [...variants.values()];
  const fallback = entries[0];
  const variantOf = request => variants.get(request.headers.get('x-studio-variant') ?? '') ?? fallback;

  // Paths: the browser names workspace files `/workspace/<path>`; a variant's environment may keep them elsewhere.
  const virtual = (variant, path) => `${VIRTUAL_ROOT}${path.slice(variant.root.length)}`;
  const validPath = path => path.startsWith(`${VIRTUAL_ROOT}/`) && !path.split('/').includes('..');
  async function walk(variant, path = variant.root) {
    const files = [];
    for (const entry of ok(await variant.env.listDir(path, context)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || isTemporary(entry.name)) continue;
      const child = `${path}/${entry.name}`;
      if (entry.kind === 'directory') files.push(...await walk(variant, child)); else if (entry.kind === 'file') files.push(child);
    }
    return files;
  }
  const toBytes = content => typeof content === 'string' ? new TextEncoder().encode(content) : content;
  /** Puts a scenario's files in the workspace (only those that are missing) and commits them when the variant has a repository. */
  async function seed(variant, scenario) {
    const written = [];
    for (const [path, content] of Object.entries(scenario.seed ?? {})) if (await createFile(variant, path, toBytes(content))) written.push(path);
    if (written.length && scenario.seedCommit && variant.infra.commit) await variant.infra.commit(written, scenario.seedCommit);
    return written;
  }

  // ---- Durable native sessions. Reopening the same file resumes unfinished work.
  const registry = createRegistry();
  for (const variant of entries) variant.agent.install(registry);
  const environments = new Map(), byCwd = new Map(entries.map(variant => [variant.root, variant.env]));
  harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'session.sqlite')), { registry, models,
    env: target => environments.get(String(target.conversationId)) ?? byCwd.get(target.cwd) ?? fallback.env }, context);
  // The conversation list (title, last message, last activity, archived, deleted) is one native document per conversation
  // (`@boring/agent/conversations`), kept by Pi with the transcript. A conversation's owner is its variant's agent.
  const managed = createConversations({ harness, context, onError: error => console.error('conversation metadata:', error?.message ?? error) });
  // The live handles the chat transport serves (deleted ones are dropped), and the variant each belongs to.
  const conversations = new Map(), variantOfConversation = new Map();
  const register = (variant, conversation) => {
    conversations.set(String(conversation.id), conversation); environments.set(String(conversation.id), variant.env); variantOfConversation.set(String(conversation.id), variant);
  };
  async function create(variant) {
    const conversation = await managed.create(variant.agent.id, { start: init => variant.agent.createConversation(harness, context, { init }) });
    register(variant, conversation);
    return conversation;
  }
  // Dev data of earlier studio versions: its own index and activity files are read once, their conversations adopted, then set aside.
  const legacyIndex = join(directory, 'conversations.json'), legacyActivity = join(directory, 'conversation-activity.json');
  if (existsSync(legacyIndex)) {
    const index = JSON.parse(readFileSync(legacyIndex, 'utf8'));
    const activity = existsSync(legacyActivity) ? JSON.parse(readFileSync(legacyActivity, 'utf8')) : {};
    for (const [owner, ids] of Object.entries(index)) for (const id of ids) await managed.adopt(id, owner, activity[String(id)] ? { updatedAt: activity[String(id)] } : {});
    renameSync(legacyIndex, `${legacyIndex}.migrated`);
    if (existsSync(legacyActivity)) renameSync(legacyActivity, `${legacyActivity}.migrated`);
  }
  for (const variant of entries) {
    let cursor;
    do {
      const page = await managed.list({ owner: variant.agent.id, archived: 'all', limit: 200, ...(cursor ? { cursor } : {}) });
      for (const item of page.items) { const found = await harness.conversation(item.id, context); if (found) register(variant, found); }
      cursor = page.next;
    } while (cursor);
    if (![...variantOfConversation.values()].includes(variant)) await create(variant);
  }
  // The History list's operations (list and search, create, rename, archive, delete, fork), scoped to the variant's agent.
  for (const variant of entries) variant.conversationsHandler = createConversationsHandler({ conversations: managed, authenticate: async request => authenticated(request) ? {
    owner: variant.agent.id, start: init => variant.agent.createConversation(harness, context, { init }),
    opened: conversation => register(variant, conversation),
    deleted: async id => {
      conversations.delete(String(id)); environments.delete(String(id)); variantOfConversation.delete(String(id));
      if (![...variantOfConversation.values()].includes(variant)) await create(variant);
    },
  } : null });
  // A self-evolving agent's `.agent/` lives in its workspace: the same scan as `reload` reinstalls it before any conversation resumes.
  for (const variant of entries) {
    if (!variant.agent.reload) continue;
    const report = await variant.agent.reload(variant.env, context);
    if (report.errors.length) console.error(`.agent/ of ${variant.id} on open:\n${report.text}`);
  }
  // Metering: the ledger is a SQLite file of the host; runs a previous process left open are finished from Pi's durable state.
  const creditsDb = openNodeConnection(join(directory, 'credits.sqlite'));
  const ledger = createSqliteLedger({ connection: creditsDb, holdMicros: CREDITS.holdMicros });
  await ledger.grant(human.principalId, CREDITS.startMicros, 'studio-start');
  const meter = createMeter({ sink: ledger, context, models, markup: CREDITS.markup });
  await meter.recover(harness);
  harness.resume();
  // External channels (WhatsApp) when configured: same harness and conversations, own signed webhook instead of the bearer token.
  const channelEntries = entries.map(variant => ({ ...variant, agent: variant.agent }));
  const channels = whatsapp ? startChannels({ directory, harness, context, agents: channelEntries, conversations, create: entry => create(variants.get(entry.id)), whatsapp }) : undefined;
  await channels?.start();

  function authenticated(request) { return request.headers.get('authorization') === `Bearer ${token}`; }
  const ownerOf = conversation => variantOfConversation.get(String(conversation.id));
  const chat = createChatTransportHandler({ ...(heartbeatMs === undefined ? {} : { heartbeatMs }), authenticate: async request => {
    const conversation = conversations.get(new URL(request.url).searchParams.get('conversation') ?? '');
    if (!authenticated(request) || !conversation) return null;
    const owner = ownerOf(conversation);
    // Every message sees what the person attached or @mentioned: the host reads the workspace and adds the files to the input.
    // In a variant with credits a message is reserved against the person's balance before it reaches the conversation (or refused).
    return { conversation: owner.descriptor.credits ? meter.conversation(conversation, human.principalId) : conversation, context, prepareInput: owner.mentions, abortSubmission: id => harness.abortSubmission(id, context, conversation.id),
      answer: (callId, answer) => answerUserQuestion(conversation, callId, answer, context), configure: change => configure(conversation, change) };
  } });
  // The host owns the allow-list: a change outside the declared models and efforts is refused, not applied.
  const configure = (conversation, change) => configureOffered(conversation, change, context, model => offered.some(item => item.provider === model.provider && item.modelId === model.modelId));
  const describeVariant = (descriptor, variant) => ({
    id: descriptor.id, title: descriptor.title, description: descriptor.description, available: variant !== undefined,
    ...(descriptor.available === true ? {} : { reason: descriptor.available.reason }), ...(descriptor.link ? { link: descriptor.link } : {}),
    ...(variant ? {
      agent: variant.agent.id, model: `${variant.agent.agent.model.provider}/${variant.agent.agent.model.modelId}`, capabilities: variant.capabilities, skills: variant.agent.skills,
      selfEvolving: Boolean(variant.agent.reload),
      tools: variant.agent.extensions.flatMap(extension => (extension.tools ?? []).map(tool => tool.name)),
      chat: { models: offered.map(model => ({ provider: model.provider, modelId: model.modelId, label: model.label })), efforts: EFFORTS },
      notes: variant.notes, canvas: variant.canvas,
      conversations: [...variantOfConversation].filter(([, owner]) => owner === variant).map(([id]) => Number(id)).sort((a, b) => a - b),
    } : {}),
  });
  const describe = () => ({ variants: descriptors.map(descriptor => describeVariant(descriptor, variants.get(descriptor.id))), scenarios: scenarios.map(describeScenario) });

  async function api(request, url) {
    if (!authenticated(request)) return Response.json({ reason: 'authentication-required' }, { status: 401 });
    const variant = variantOf(request);
    if (request.method === 'GET' && url.pathname === '/api/studio') return Response.json(describe());
    const listed = /^\/api\/variants\/([a-z0-9._-]+)\/conversations$/.exec(url.pathname);
    // The History list: the variant's conversations, newest activity first (`@boring/agent/conversations`).
    if (listed) {
      const target = variants.get(listed[1]);
      if (!target) return Response.json({ reason: 'unknown-variant' }, { status: 404 });
      return target.conversationsHandler(request);
    }
    // The person's fictional credits; POST tops them back up to the starting balance (the stand-in for buying more).
    if (url.pathname === '/api/credits') {
      if (request.method === 'POST') { const { balanceMicros } = await ledger.balance(human.principalId); await ledger.grant(human.principalId, CREDITS.startMicros - balanceMicros, `top-up-${randomUUID()}`); }
      return Response.json({ ...await ledger.balance(human.principalId), holdMicros: CREDITS.holdMicros, variants: entries.filter(entry => entry.descriptor.credits).map(entry => entry.id) });
    }
    if (request.method === 'GET' && url.pathname === '/api/files') return Response.json({ files: (await walk(variant)).map(path => virtual(variant, path)) });
    // The retained versions of one workspace file (relative path) with their save times, newest first: the version list of a presented file.
    if (request.method === 'GET' && url.pathname === '/api/history') return Response.json({ saves: variant.files.saves(url.searchParams.get('path') ?? '') });
    if (request.method === 'GET' && url.pathname === '/api/file') {
      const path = url.searchParams.get('path') ?? '';
      if (!validPath(path)) return Response.json({ reason: 'invalid-path' }, { status: 400 });
      const found = await readOf(variant, path.slice(VIRTUAL_ROOT.length + 1));
      if (found.kind !== 'available') return Response.json({ reason: 'not-found' }, { status: 404 });
      const read = { value: found.snapshot.bytes };
      const mediaType = mediaTypeOf(path);
      // `raw=1` returns the bytes with their content type, for the image and PDF viewers. The sandbox policy keeps a stored SVG or
      // HTML file inert even if its URL were opened directly.
      if (url.searchParams.get('raw') === '1') return new Response(read.value, { headers: { 'content-type': mediaType, 'content-length': String(read.value.byteLength),
        'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'cache-control': 'no-store' } });
      const text = decodeText(path, read.value);
      return Response.json({ path, kind: kindOf(path), mediaType, size: read.value.byteLength, ...(text === undefined ? {} : { text }) });
    }
    if (request.method === 'GET' && url.pathname === '/api/search') {
      const needle = (url.searchParams.get('q') ?? '').toLowerCase();
      const paths = (await walk(variant)).map(path => virtual(variant, path).slice(VIRTUAL_ROOT.length + 1));
      const rank = path => path.split('/').pop().toLowerCase().includes(needle) ? 0 : 1;
      return Response.json({ results: paths.filter(path => path.toLowerCase().includes(needle)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 8).map(path => ({ path, kind: 'file' })) });
    }
    // One file per request, always saved under uploads/ (so it survives a restart and opens in the Files tab).
    if (request.method === 'POST' && url.pathname === '/api/upload') {
      const name = (url.searchParams.get('name') ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
      const mimeType = request.headers.get('content-type') ?? 'application/octet-stream';
      if (!name) return Response.json({ reason: 'invalid-name' }, { status: 400 });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > 5_000_000) return Response.json({ reason: bytes.byteLength ? 'file-too-large' : 'file-is-empty' }, { status: 413 });
      let saved = name;
      for (let n = 2; !await createFile(variant, `uploads/${saved}`, bytes); n++) saved = name.replace(/(\.[^.]*)?$/, suffix => `-${n}${suffix}`);
      // An image is also handed back as base64 for the chat to attach; the file is kept either way.
      return Response.json({ name: saved, path: `uploads/${saved}`, ...(mimeType.startsWith('image/') ? { image: { data: Buffer.from(bytes).toString('base64'), mimeType } } : {}) });
    }
    // A scenario's files and its upload fixtures.
    const scenarioRoute = /^\/api\/scenarios\/([a-z0-9-]+)\/(seed|fixture\/(\d+))$/.exec(url.pathname);
    if (scenarioRoute) {
      const scenario = scenarios.find(candidate => candidate.id === scenarioRoute[1]);
      if (!scenario) return Response.json({ reason: 'unknown-scenario' }, { status: 404 });
      if (request.method === 'POST' && scenarioRoute[2] === 'seed') return Response.json({ written: await seed(variant, scenario) });
      const upload = scenario.steps[Number(scenarioRoute[3])]?.upload;
      if (request.method === 'GET' && upload) return new Response(toBytes(upload.content), { headers: { 'content-type': upload.mimeType ?? mediaTypeOf(upload.name), 'content-disposition': `attachment; filename="${upload.name}"` } });
      return Response.json({ reason: 'not-found' }, { status: 404 });
    }
    // The Tasks tab: the child conversations of the open conversation (background subagents among them).
    if (request.method === 'GET' && url.pathname === '/api/tasks') {
      const found = await variant.subagents.describe(Number(url.searchParams.get('conversation')), variant.agent.id);
      return found ? Response.json(found) : Response.json({ reason: 'unknown-conversation' }, { status: 404 });
    }
    // The person's `/reload`: the same function as the agent's `reload` tool, over the same workspace environment.
    if (request.method === 'POST' && url.pathname === '/api/reload') {
      if (!variant.agent.reload) return Response.json({ reason: 'not-self-evolving' }, { status: 404 });
      const report = await variant.agent.reload(variant.env, context);
      return Response.json({ text: report.text, report });
    }
    if (variant.infra.routes) { const response = await variant.infra.routes(request, url); if (response) return response; }
    return Response.json({ reason: 'not-found' }, { status: 404 });
  }

  // ---- The browser app: one bundle, compiled once at startup.
  const bundle = await build({ entryPoints: [here('./browser.jsx')], bundle: true, write: false, outdir: here('./out'), format: 'esm', platform: 'browser', jsx: 'automatic',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  // CSS imported by a panel (for example a viewer's stylesheet) is bundled and served with the studio styles.
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  // Tailwind is compiled once here: the shadcn tokens (the registry `theme` item) and the utilities used by the registry items and this folder.
  const tailwind = await buildTailwind();
  const styles = [tailwind, ...bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text), readFileSync(here('./styles.css'), 'utf8')].join('\n');
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><title>Boring studio (fictional)</title>
<link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div>
<script>window.__STUDIO__=${JSON.stringify({ token, identity: { runtimeId: 'studio', ...human } })}</script>
<script type="module" src="/app.js"></script></body></html>`;
  const statics = { '/': ['text/html; charset=utf-8', page], '/app.js': ['text/javascript; charset=utf-8', script], '/styles.css': ['text/css; charset=utf-8', styles] };

  const watches = { open: 0, peak: 0, total: 0 };
  /** The chat transport behind the submit test hook (@boring/testing/network): a delayed confirmation, or a 402 `submission-refused` that never reaches the conversation. */
  const { handler: chatWithFaults, faults: submitFaults } = withSubmitFaults(chat, { delayMs: submitDelayMs, message: 'Fictional refusal (studio test hook)' });
  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url, `http://${incoming.headers.host}`);
    const closed = new AbortController();
    outgoing.on('close', () => closed.abort());
    // Debug counter for journeys (not a route): concurrent chat watch streams, which share the browser's per-host connection pool.
    if (url.pathname === '/api/chat' && url.searchParams.get('op') === 'watch') { watches.open++; watches.total++; watches.peak = Math.max(watches.peak, watches.open); outgoing.on('close', () => { watches.open--; }); }
    try {
      const fixed = incoming.method === 'GET' && statics[url.pathname];
      if (fixed) return void outgoing.writeHead(200, { 'content-type': fixed[0], 'cache-control': 'no-store' }).end(fixed[1]);
      const request = await webRequest(incoming, url, { signal: closed.signal });
      if (!request) return void outgoing.writeHead(413).end();
      const channel = channels && Object.hasOwn(channels.routes, url.pathname) ? channels.routes[url.pathname] : undefined;
      const response = channel ? await channel(request) : url.pathname === '/api/chat' ? await chatWithFaults(request)
        : url.pathname === '/api/resources' ? await variantOf(request).resourceHandler(request) : await api(request, url);
      await sendWebResponse(response, outgoing, { signal: closed.signal });
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
      if (!closed.signal.aborted) console.error('request failed:', error?.message ?? error);
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`, port: server.address().port, token, provider, scripted, scriptMisses, channels: channels ? { whatsapp: channels.agent } : {},
    /** The variants as the browser sees them, with availability. */
    watches, submitFaults, variants: () => describe().variants, scenarios: () => scenarios, agents: () => entries.map(variant => describeVariant(variant.descriptor, variant)),
    harness, conversations, files: fallback.files, host: { ...hostInfo, agentAccess, env: fallback.env, variants },
    persist: async () => { for (const variant of entries) await variant.infra.persist?.(); },
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await channels?.close();
      await meter.close();
      await managed.dispose();
      await harness.close(context);
      creditsDb.close();
      for (const variant of entries) { for (const connection of variant.mcp) await connection.close(); await variant.infra.close?.(); }
      workspaceDb.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startStudio({ directory: process.env.STUDIO_DATA ?? '.cache/studio', port: Number(process.env.PORT ?? 4180) });
  const unavailable = app.variants().filter(variant => !variant.available);
  console.log(`Studio on ${app.url} (${app.provider}). Variants: ${app.variants().filter(variant => variant.available).map(variant => variant.id).join(', ')}${unavailable.length ? `; unavailable: ${unavailable.map(variant => `${variant.id} (${variant.reason})`).join('; ')}` : ''}. Fictional content only. Data in ${process.env.STUDIO_DATA ?? '.cache/studio'}.`);
  if (app.channels.whatsapp) console.log(`WhatsApp webhook: ${app.url}api/channels/whatsapp -> agent ${app.channels.whatsapp}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().finally(() => process.exit(0)); });
}
