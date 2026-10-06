// MCP servers for the Durable Object: Cloudflare's `MCPClientManager` (agents/mcp/client) installed on the object's Lifecycle keeps
// the connections, persists them in this object's SQLite (`cf_agents_mcp_servers`), reconnects them after a restart and runs MCP
// OAuth; `@boring/agent/mcp` turns each connected server into one native Pi extension (`mcp.<id>`, tools `<id>__<tool>`) installed in
// the normal registry. Which conversations may use a server is host policy (`granted`), and a granted conversation selects the
// extension with the native `configure`. Writes wait for the person's approval (`requireApproval`), on the web or as a WhatsApp reply.
//
// Configuration (Worker var or secret MCP_SERVERS, a JSON array):
//   [{ "id": "gmail", "url": "https://backend.composio.dev/v3/mcp/<server>?user_id={user}", "headers": { "x-api-key": "COMPOSIO_API_KEY" },
//      "allow": ["GMAIL_FETCH_EMAILS"], "approve": "writes" }]
// - `headers` name Worker secrets; their values are sent to that server only and never reach the model or the transcript.
// - `{user}` in the URL is the owner's id (MCP_USER_ID, default "owner"; one owner per object for now).
// - `oauth: true` for a server that signs the person in with MCP OAuth; `connect_service` then returns the sign-in link.
// - `allow` lists the upstream tool names exposed ("all" exposes every listed tool); `readOnly` lists the tools the host declares as reads (server annotations count for nothing); `approve` is "composio" (Composio Tool Router: see composio-policy.mjs), "writes" (default: every tool the
//   server does not mark read-only asks first) or "none".
//
// Experimental surface: Cloudflare marks installing MCPClientManager directly on a Lifecycle (outside `agent.mcp`) as experimental.
// The manager persists transport options, so header values (the API key) are stored in this object's SQLite with the server row.
import { MCPClientManager } from 'agents/mcp/client';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { createMcpExtension, isMcpSourceId } from '@boring/agent/mcp';
import { composioPolicy } from './composio-policy.mjs';

/** Where an MCP OAuth provider sends the person back. The Worker forwards it without the bearer token; the manager checks its state. */
export const MCP_CALLBACK_PATH = '/api/mcp/callback';
/** The host tools' extension (connect_service, and later connect_account). Not `mcp.`-prefixed: it is selected explicitly. */
export const SERVICES_EXTENSION = 'cloudflare.services';
const CLIENT_NAME = 'boring-assistant';
const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const toolsKey = id => `mcp-tools:${id}`;
const configKey = id => `mcp-config:${id}`;
/** A server whose connection failed is tried again by a later `ready()`, at most once per this many milliseconds. */
const RETRY_AFTER_MS = 30_000;

const escape = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const text = (value, isError = false) => ({ isError, content: [{ type: 'text', text: value }] });

/**
 * The MCP servers of the Worker environment: valid entries, and an error for each invalid one (shown by `status`, never thrown,
 * so one bad entry does not stop the object).
 */
export function mcpServerSettings(env) {
  const raw = env.MCP_SERVERS;
  if (raw === undefined || raw === null || raw === '') return { servers: [], invalid: [] };
  let list;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { servers: [], invalid: [{ id: '(MCP_SERVERS)', error: 'not valid JSON' }] }; }
  if (!Array.isArray(list)) return { servers: [], invalid: [{ id: '(MCP_SERVERS)', error: 'must be a JSON array' }] };
  const user = env.MCP_USER_ID || 'owner';
  const servers = [], invalid = [], seen = new Set();
  for (const entry of list) {
    const id = entry?.id;
    const fail = error => invalid.push({ id: typeof id === 'string' ? id : '(no id)', error });
    // The adapter's own rule (no `__`, no leading or trailing separator), so a configured id can never fail later at restore.
    if (!isMcpSourceId(id)) { fail('id must be up to 40 characters: lowercase words joined by single - or _'); continue; }
    if (seen.has(id)) { fail('duplicate id'); continue; }
    seen.add(id);
    let url;
    try { url = new URL(String(entry.url).replaceAll('{user}', encodeURIComponent(user))); } catch { fail('url is not a URL'); continue; }
    // Plain HTTP only to this machine (local journeys); a deployment talks to its servers over HTTPS.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) { fail('url must be https'); continue; }
    if (entry.allow !== 'all' && !(Array.isArray(entry.allow) && entry.allow.every(name => typeof name === 'string' && name))) { fail('allow must be a list of tool names or "all"'); continue; }
    if (entry.approve !== undefined && !['writes', 'none', 'composio'].includes(entry.approve)) { fail('approve must be "writes", "none" or "composio"'); continue; }
    const headers = {}, secrets = [];
    let missing;
    for (const [name, secret] of Object.entries(entry.headers ?? {})) {
      if (typeof secret !== 'string' || !SECRET.test(secret)) { missing = `header ${name} must name a Worker secret (A-Z, 0-9, _)`; break; }
      const value = env[secret];
      if (typeof value !== 'string' || !value) { missing = `the Worker secret ${secret} is not set`; break; }
      headers[name] = value; secrets.push(value);
    }
    if (missing) { fail(missing); continue; }
    if (entry.readOnly !== undefined && !(Array.isArray(entry.readOnly) && entry.readOnly.every(name => typeof name === 'string' && name))) { fail('readOnly must be a list of tool names'); continue; }
    servers.push({ id, url: url.href, headers, secrets, allow: entry.allow, approve: entry.approve ?? 'writes', readOnly: entry.readOnly ?? [], oauth: entry.oauth === true });
  }
  return { servers, invalid };
}

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The tool fields `createMcpExtension` reads, without the manager's `serverId` (also what is cached for the next start). */
const listedTool = ({ name, title, description, inputSchema, annotations }) => ({ name, ...(title ? { title } : {}), ...(description ? { description } : {}),
  ...(inputSchema ? { inputSchema } : {}), ...(annotations ? { annotations } : {}) });

export class McpServices {
  #env; #storage; #registry; #granted; #origin; #start; #resolveUrl;
  #extensions = new Map();
  #tools = new Map();
  /** Server id → the tool list (JSON) its installed extension was last built from, whether or not that build succeeded. */
  #installed = new Map();
  /** Server id → the tool list (JSON) known to be in the cache, so a failed cache write is retried by the next refresh. */
  #cached = new Map();
  /** Server id → why its last build failed (redacted); the server keeps its previous (or an empty) extension. */
  #failed = new Map();
  #syncing;
  /** Server id → when its connection was last attempted, so a failed one is retried by `ready()` with a backoff. */
  #attempted = new Map();
  #retrying;
  /** One queue for every install, restore and discovery alike, so an older list can never land after a newer one. */
  #queue = Promise.resolve();
  /** Extra host tools for the services extension: the seam for Composio's `connect_account({ toolkit })` (not built yet). */
  #hostTools;

  /**
   * @param {object} options
   * @param {object} options.env the Worker environment (MCP_SERVERS, MCP_USER_ID and the secrets it names)
   * @param {DurableObjectStorage} options.storage
   * @param {import('@earendil-works/pi-durable').Registry} options.registry
   * @param {(conversationId: number) => Promise<boolean>} options.granted host policy, checked inside every MCP call
   * @param {() => Promise<string | undefined>} options.origin the public origin, for the OAuth callback URL
   * @param {() => Promise<void>} options.start starts the object's Lifecycle (the manager restores its servers then)
   * @param {object[]} [options.hostTools]
   * @param {MCPClientManager} [options.manager] the client manager (tests pass a fake); default a new MCPClientManager
   * @param {(server: object) => Promise<string>} [options.resolveUrl] the URL to register a server at, resolved when it is first
   *   connected (a person's Composio session is created then, see composio-session.mjs); default the configured URL
   */
  constructor({ env, storage, registry, granted, origin, start, hostTools = [], manager, resolveUrl }) {
    this.#env = env; this.#storage = storage; this.#registry = registry; this.#granted = granted; this.#origin = origin; this.#start = start; this.#hostTools = hostTools; this.#resolveUrl = resolveUrl;
    const { servers, invalid } = mcpServerSettings(env);
    this.servers = servers; this.invalid = invalid;
    for (const item of invalid) console.warn(`MCP server ${item.id} skipped: ${item.error}`);
    this.manager = manager ?? new MCPClientManager(CLIENT_NAME, '1.0.0', { env });
    // After MCP OAuth the person lands on a plain page; the manager has already stored the tokens and reconnects in the background.
    this.manager.configureOAuthCallback({ customHandler: result => new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Service connection</title><body style="font:16px system-ui;margin:2rem">${result.authSuccess
        ? `<p>${escape(result.serverId)} is connected. You can close this page and go back to the chat.</p>` : `<p>The connection failed: ${escape(result.authError)}</p>`}</body>`,
      { status: result.authSuccess ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }) });
    this.manager.onServerStateChanged(() => { void this.#refresh(); });
    const services = [...(servers.some(server => server.oauth) ? [this.#connectService()] : []), ...hostTools];
    this.servicesExtension = services.length ? defineExtension({ name: SERVICES_EXTENSION, tools: services }) : undefined;
  }

  /** Whether any server is configured. */
  get configured() { return this.servers.length > 0; }

  /**
   * Install every configured server's extension before the Harness opens, from the tool list cached at its last connection (empty the
   * first time). Selection is by extension name, so a granted conversation keeps its selection while a server reconnects, and a call
   * replayed after a restart finds its tool. Never throws: a server that cannot be built is reported by `status` and gets an empty
   * extension, so one optional server never stops the Harness from opening.
   */
  async restore() {
    await this.#enqueue(async () => {
      for (const server of this.servers) {
        // A discovery that ran first installed a newer list than the cache had: keep it.
        if (this.#installed.has(server.id)) continue;
        let cached;
        try { cached = await this.#storage.get(toolsKey(server.id)); } catch (error) { console.warn(`MCP server ${server.id}: cached tools unreadable`, String(error?.message ?? error).slice(0, 200)); }
        if (Array.isArray(cached)) this.#cached.set(server.id, JSON.stringify(cached));
        await this.#installSafely(server, Array.isArray(cached) ? cached : []);
      }
    });
    if (this.servicesExtension) this.#registry.install(this.servicesExtension);
  }

  #enqueue(work) {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** The extensions a granted conversation selects. */
  extensions() { return [...this.#extensions.values(), ...(this.servicesExtension ? [this.servicesExtension] : [])]; }

  /** Register servers from the configuration once per object start, wait (bounded) for connections, and refresh tool lists. */
  async ready({ timeout = 15_000 } = {}) {
    if (!this.configured) return;
    await this.#start();
    this.#syncing ??= this.#sync().catch(error => { this.#syncing = undefined; throw error; });
    await this.#syncing;
    this.#retrying ??= this.#retryFailed().finally(() => { this.#retrying = undefined; });
    await this.#retrying;
    await this.manager.waitForConnections({ timeout });
    await this.#refresh();
  }

  /** Each server's connection state and exposed tools, for the owner. Errors are redacted. */
  status() {
    return [
      ...this.servers.map(server => {
        const connection = this.manager.mcpConnections[server.id];
        const error = connection?.connectionError ? this.#redact(server)(String(connection.connectionError)).slice(0, 300) : undefined;
        const failure = error ?? this.#failed.get(server.id);
        return { id: server.id, state: connection?.connectionState ?? 'not-connected', oauth: server.oauth, tools: [...(this.#tools.get(server.id)?.keys() ?? [])], ...(failure ? { error: failure } : {}) };
      }),
      ...this.invalid.map(item => ({ id: item.id, state: 'invalid', error: item.error })),
    ];
  }

  /** The OAuth callback (`MCP_CALLBACK_PATH`): the manager answers a request whose state names one of its servers. */
  onRequest(request) { return this.manager.onRequest({ request }); }

  /** Registration follows the configuration: a server is (re)registered when its URL, headers or OAuth setting changed. */
  async #sync() {
    const rows = new Map(this.manager.listServers().map(row => [row.id, row]));
    for (const id of rows.keys()) if (!this.servers.some(server => server.id === id)) { await this.manager.removeServer(id); await this.#storage.delete([toolsKey(id), configKey(id)]); }
    for (const server of this.servers) await this.#attempt(server, rows.get(server.id));
  }

  async #attempt(server, row) {
    this.#attempted.set(server.id, Date.now());
    try { await this.#register(server, row); } catch (error) { console.warn(`MCP server ${server.id}: ${this.#redact(server)(String(error?.message ?? error)).slice(0, 200)}`); }
  }

  /**
   * The initial sync settles even when a connection failed (a transient outage). A server left unregistered (its registration threw)
   * or failed is attempted again through the same registration path, at most once per RETRY_AFTER_MS. An OAuth server that failed is
   * left to `connect_service`, which issues a new sign-in link; only its registration is retried here.
   */
  async #retryFailed() {
    const rows = new Map(this.manager.listServers().map(row => [row.id, row]));
    for (const server of this.servers) {
      const state = this.manager.mcpConnections[server.id]?.connectionState;
      const unsettled = !rows.has(server.id) || !this.manager.mcpConnections[server.id] || (state === 'failed' && !server.oauth);
      if (!unsettled || Date.now() - (this.#attempted.get(server.id) ?? 0) < RETRY_AFTER_MS) continue;
      await this.#attempt(server, rows.get(server.id));
    }
  }

  async #register(server, row) {
    const origin = server.oauth ? await this.#origin() : undefined;
    if (server.oauth && !origin) throw new Error('an OAuth server needs the public origin; open the app once first');
    const callbackUrl = origin ? `${origin}${MCP_CALLBACK_PATH}` : undefined;
    const url = this.#resolveUrl ? await this.#resolveUrl(server) : server.url;
    const print = await digest({ url, headers: server.headers, callbackUrl: callbackUrl ?? null });
    if (row && await this.#storage.get(configKey(server.id)) === print) {
      // Restored by the manager at start; a failed connection is attempted again (and later by #retryFailed, with a backoff).
      const connection = this.manager.mcpConnections[server.id];
      if (connection?.connectionState === 'failed') await this.#connect(server.id);
      return;
    }
    if (row) await this.manager.removeServer(server.id);
    await this.manager.registerServer(server.id, { url, name: server.id, transport: { type: 'streamable-http', requestInit: { headers: server.headers } }, ...(callbackUrl ? { callbackUrl } : {}) });
    await this.#storage.put(configKey(server.id), print);
    await this.#connect(server.id);
  }

  async #connect(id) {
    const result = await this.manager.connectToServer(id);
    if (result.state === 'connected') await this.manager.discoverIfConnected(id);
    return result;
  }

  /**
   * Rebuild the extension of every ready server whose discovered tool list differs from the INSTALLED one (not only the cache, so a
   * stale restore is repaired). The list is persisted for the next start BEFORE its extension is installed: when the write fails the
   * new list is not exposed (a restart could only restore the older one), and the next refresh retries both. Queued behind any restore
   * or earlier discovery.
   */
  #refresh() {
    return this.#enqueue(async () => {
      for (const server of this.servers) {
        try {
          if (this.manager.mcpConnections[server.id]?.connectionState !== 'ready') continue;
          const tools = this.manager.listTools({ serverId: server.id }).map(listedTool);
          const json = JSON.stringify(tools);
          if (this.#installed.get(server.id) === json) continue;
          let built;
          try { built = await this.#build(server, tools); } catch (error) { await this.#fail(server, error); this.#installed.set(server.id, json); continue; }
          if (this.#cached.get(server.id) !== json) {
            await this.#storage.put(toolsKey(server.id), tools);
            this.#cached.set(server.id, json);
          }
          this.#apply(server, built);
          this.#installed.set(server.id, json);
        } catch (error) { console.warn(`MCP tool refresh failed for ${server.id}`, this.#redact(server)(String(error?.message ?? error)).slice(0, 200)); }
      }
    }).catch(error => console.warn('MCP tool refresh failed', String(error?.message ?? error).slice(0, 200)));
  }

  /** Build and install one server's extension (restore); on failure keep its previous extension (or install an empty one). */
  async #installSafely(server, listed) {
    try { this.#apply(server, await this.#build(server, listed)); } catch (error) { await this.#fail(server, error); } finally { this.#installed.set(server.id, JSON.stringify(listed)); }
  }

  /** Report why a build failed; an empty extension keeps the name a granted conversation selected resolvable (no calls offered). */
  async #fail(server, error) {
    const reason = this.#redact(server)(String(error?.message ?? error)).slice(0, 300);
    console.warn(`MCP server ${server.id} not installed: ${reason}`);
    if (!this.#extensions.has(server.id)) { try { this.#apply(server, await this.#build(server, [])); } catch { /* nothing more to try */ } }
    this.#failed.set(server.id, reason);
  }

  #redact(server) {
    return value => server.secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  }

  async #build(server, listed) {
    const source = {
      id: server.id,
      listTools: async () => listed,
      callTool: async (name, args, call) => {
        try { await this.ready({ timeout: 10_000 }); } catch { /* reported by the state below */ }
        const state = this.manager.mcpConnections[server.id]?.connectionState;
        if (state !== 'ready') return text(`${server.id} is not connected right now (${state ?? 'not registered'}).${server.oauth ? ' Ask the person to sign in with connect_service.' : ''}`, true);
        // The manager strips the first `<serverId>.` from the name before dispatch: qualify it, so the exact upstream name (the one
        // allowed, declared read-only and approved) reaches the server even when it contains `<serverId>.` itself.
        try { return await this.manager.callTool({ serverId: server.id, name: `${server.id}.${name}`, arguments: args }, call.signal ? { signal: call.signal } : undefined); }
        catch (error) { return text(`${server.id} failed: ${this.#redact(server)(String(error?.message ?? error)).slice(0, 500)}`, true); }
      },
    };
    return createMcpExtension({ source, allow: server.allow, redact: this.#redact(server), granted: this.#granted,
      // Reads are the host's word only (`readOnly` in MCP_SERVERS): server annotations decide nothing.
      ...(server.approve === 'composio' ? composioPolicy(server.readOnly) : { readOnly: tool => server.readOnly.includes(tool.name), ...(server.approve === 'none' ? { approve: () => false } : {}) }) });
  }

  #apply(server, built) {
    this.#failed.delete(server.id);
    this.#registry.install(built.extension);
    this.#extensions.set(server.id, built.extension);
    this.#tools.set(server.id, built.tools);
  }

  /**
   * Whether a stored sign-in link can still complete: the OAuth provider keeps each link's `state` for a limited time (10 minutes in
   * agents' DurableObjectOAuthClientProvider), and the manager restores the link after a restart without checking it.
   */
  async #pendingValid(server, link) {
    try {
      const state = new URL(link).searchParams.get('state');
      const provider = this.manager.mcpConnections[server.id]?.options?.transport?.authProvider;
      return Boolean(state && provider && (await provider.checkState(state)).valid);
    } catch { return false; }
  }

  /** `connect_service({ id })`: the sign-in link of an OAuth server, for the agent to send (on WhatsApp, as a message). */
  #connectService() {
    return defineTool({
      name: 'connect_service',
      description: `Connect an external service the person must sign in to. Returns a sign-in link to send to the person exactly as given (they open it, sign in, and come back), or says the service is already connected. Services: ${this.servers.filter(server => server.oauth).map(server => server.id).join(', ')}.`,
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      replay: 'safe',
      execute: async (args, api) => {
        if (!await this.#granted(api.conversationId)) return text('This conversation may not connect services.', true);
        const server = this.servers.find(item => item.id === args.id);
        if (!server) return text(`Unknown service. Known: ${this.servers.map(item => item.id).join(', ')}.`, true);
        try { await this.ready({ timeout: 5_000 }); } catch (error) { return text(`Could not reach ${server.id}: ${this.#redact(server)(String(error?.message ?? error)).slice(0, 200)}`, true); }
        const state = this.manager.mcpConnections[server.id]?.connectionState;
        if (state === 'ready') return text(`${server.id} is already connected.`);
        // A Composio-style server (API key, no MCP OAuth) connects accounts with its own API: that is `connect_account`, not this tool.
        if (!server.oauth) return text(`${server.id} needs no sign-in here; it is ${state ?? 'not connected'}.`, true);
        const pending = this.manager.listServers().find(row => row.id === server.id)?.auth_url;
        if (state === 'authenticating' && pending && await this.#pendingValid(server, pending)) return text(`Sign-in link for ${server.id}: ${pending}`);
        // Otherwise (or once its state expired) connecting again issues a fresh link through the manager.
        const result = await this.#connect(server.id);
        if (result.state === 'authenticating') return text(`Sign-in link for ${server.id}: ${result.authUrl}`);
        if (result.state === 'connected') { await this.#refresh(); return text(`${server.id} is connected.`); }
        return text(`${server.id} could not connect: ${this.#redact(server)(result.error ?? 'unknown error').slice(0, 300)}`, true);
      },
    });
  }
}
