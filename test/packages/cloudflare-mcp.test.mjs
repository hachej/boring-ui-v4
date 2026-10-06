import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { MCPClientManager } from 'agents/mcp/client';
import { McpServices, mcpServerSettings } from '../../examples/cloudflare/src/mcp.mjs';

// McpServices with fakes for Cloudflare's MCPClientManager, the object's storage and the native registry: no network, no Worker.

const tool = name => ({ name, description: `Fictional ${name}.`, inputSchema: { type: 'object', properties: {} } });
const STALE = [tool('old_search')];
const FRESH = [tool('new_search'), tool('new_send')];

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const held = [];
  return {
    values, held,
    /** The next `get` of `key` waits until released, returning the value it read when called (a slow storage read). */
    hold: key => { held.push({ key }); },
    get: async key => {
      const value = values.get(key);
      const index = held.findIndex(item => item.key === key && !item.release);
      if (index < 0) return value;
      const item = held[index];
      await new Promise(resolve => { item.release = resolve; });
      return value;
    },
    put: async (key, value) => { values.set(key, value); },
    delete: async keys => { for (const key of [].concat(keys)) values.delete(key); },
  };
}

function fakeManager() {
  const listeners = [];
  return {
    mcpConnections: {},
    tools: {},
    configureOAuthCallback: () => {},
    onServerStateChanged: listener => { listeners.push(listener); },
    changed: () => { for (const listener of listeners) listener(); },
    listServers: () => [],
    registerServer: async () => {},
    removeServer: async () => {},
    connectToServer: async () => ({ state: 'connected' }),
    discoverIfConnected: async () => {},
    waitForConnections: async () => {},
  };
}

function fakeRegistry() {
  const installed = new Map();
  return { installed, install: extension => { installed.set(extension.name, extension); }, toolsOf: name => installed.get(name)?.tools.map(item => item.name) };
}

function services({ servers, storage = fakeStorage(), manager = fakeManager(), origin = undefined }) {
  manager.listTools = ({ serverId }) => manager.tools[serverId] ?? [];
  const registry = fakeRegistry();
  const mcp = new McpServices({ env: { MCP_SERVERS: JSON.stringify(servers) }, storage, registry, granted: async () => true, origin: async () => origin, start: async () => {}, manager });
  return { mcp, storage, manager, registry };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('restore and discovery are serialized: a stale restore landing late is repaired by discovery', async () => {
  const storage = fakeStorage({ 'mcp-tools:alpha': STALE });
  const { mcp, manager, registry } = services({ servers: [{ id: 'alpha', url: 'https://fixture.invalid/mcp', allow: 'all' }], storage });
  storage.hold('mcp-tools:alpha');
  const restoring = mcp.restore(); // reads the cache slowly
  await tick();
  // Meanwhile the manager connects and discovers the current list.
  manager.mcpConnections.alpha = { connectionState: 'ready' };
  manager.tools.alpha = FRESH;
  manager.changed();
  await tick();
  storage.held[0].release(); // the stale cache read completes after discovery
  await restoring;
  await mcp.ready();
  assert.deepEqual(registry.toolsOf('mcp.alpha'), ['alpha__new_search', 'alpha__new_send'], 'the discovered list wins');
  assert.deepEqual(storage.values.get('mcp-tools:alpha'), FRESH);
  assert.deepEqual(mcp.status()[0].tools, ['alpha__new_search', 'alpha__new_send']);
});

test('discovery compares with the installed list, not the cache: an up-to-date cache does not hide a stale extension', async () => {
  const storage = fakeStorage({ 'mcp-tools:alpha': STALE });
  const { mcp, manager, registry } = services({ servers: [{ id: 'alpha', url: 'https://fixture.invalid/mcp', allow: 'all' }], storage });
  await mcp.restore();
  assert.deepEqual(registry.toolsOf('mcp.alpha'), ['alpha__old_search']);
  storage.values.set('mcp-tools:alpha', FRESH); // the cache already holds the new list (written by an earlier discovery)
  manager.mcpConnections.alpha = { connectionState: 'ready' };
  manager.tools.alpha = FRESH;
  await mcp.ready();
  assert.deepEqual(registry.toolsOf('mcp.alpha'), ['alpha__new_search', 'alpha__new_send']);
});

test('ids the adapter rejects are refused at parse time; a server that cannot be built never stops restore', async () => {
  const servers = [
    { id: 'alpha', url: 'https://fixture.invalid/a', allow: 'all' },
    { id: 'alpha__beta', url: 'https://fixture.invalid/b', allow: 'all' },
    { id: '-lead', url: 'https://fixture.invalid/c', allow: 'all' },
    { id: 'wide', url: 'https://fixture.invalid/d', allow: 'all' },
  ];
  const settings = mcpServerSettings({ MCP_SERVERS: JSON.stringify(servers) });
  assert.deepEqual(settings.servers.map(server => server.id), ['alpha', 'wide']);
  assert.deepEqual(settings.invalid.map(item => item.id), ['alpha__beta', '-lead']);
  // `wide` cached more tools than the adapter accepts: its build throws, and restore still installs everything else.
  const storage = fakeStorage({ 'mcp-tools:alpha': STALE, 'mcp-tools:wide': Array.from({ length: 129 }, (_, index) => tool(`t${index}`)) });
  const { mcp, registry } = services({ servers, storage });
  await mcp.restore();
  assert.deepEqual(registry.toolsOf('mcp.alpha'), ['alpha__old_search']);
  assert.deepEqual(registry.toolsOf('mcp.wide'), [], 'an empty extension keeps the selected name resolvable');
  const status = Object.fromEntries(mcp.status().map(item => [item.id, item]));
  assert.match(status.wide.error, /at most 128 tools/);
  assert.equal(status['alpha__beta'].state, 'invalid');
  assert.equal(status.alpha.error, undefined);
});

test('a discovered list is persisted before it is exposed: after a failed write a restart restores what the registry exposed, and the next refresh retries', async () => {
  const storage = fakeStorage({ 'mcp-tools:alpha': STALE });
  const put = storage.put, writes = [];
  storage.put = async (key, value) => { if (key !== 'mcp-tools:alpha') return put(key, value); writes.push(key); if (writes.length === 1) throw new Error('storage unavailable'); return put(key, value); };
  const { mcp, manager, registry } = services({ servers: [{ id: 'alpha', url: 'https://fixture.invalid/mcp', allow: 'all' }], storage });
  await mcp.restore();
  manager.mcpConnections.alpha = { connectionState: 'ready' };
  manager.tools.alpha = FRESH;
  await mcp.ready();
  // The write failed: the new list is not exposed, and a restart right now restores the same (old) list.
  assert.deepEqual(registry.toolsOf('mcp.alpha'), ['alpha__old_search']);
  const restarted = services({ servers: [{ id: 'alpha', url: 'https://fixture.invalid/mcp', allow: 'all' }], storage });
  await restarted.mcp.restore();
  assert.deepEqual(restarted.registry.toolsOf('mcp.alpha'), registry.toolsOf('mcp.alpha'));
  await mcp.ready();
  assert.deepEqual(writes, ['mcp-tools:alpha', 'mcp-tools:alpha']);
  assert.deepEqual(registry.toolsOf('mcp.alpha'), ['alpha__new_search', 'alpha__new_send']);
  const again = services({ servers: [{ id: 'alpha', url: 'https://fixture.invalid/mcp', allow: 'all' }], storage });
  await again.mcp.restore();
  assert.deepEqual(again.registry.toolsOf('mcp.alpha'), ['alpha__new_search', 'alpha__new_send']);
});

test("the exact allowed upstream name reaches the server through the real manager's callTool, even one containing `<id>.`", async () => {
  const received = [];
  const manager = fakeManager();
  manager.callTool = MCPClientManager.prototype.callTool; // agents' own dispatch, which strips the first `<serverId>.`
  manager.mcpConnections.alpha = { connectionState: 'ready', client: { callTool: async params => { received.push(params.name); return { content: [{ type: 'text', text: 'ok' }] }; } } };
  manager.tools.alpha = [tool('alpha.lookup'), tool('lookup')];
  const { mcp, registry } = services({ servers: [{ id: 'alpha', url: 'https://fixture.invalid/mcp', allow: ['alpha.lookup'], readOnly: ['alpha.lookup'] }], manager });
  await mcp.restore();
  await mcp.ready();
  const [exposed] = registry.installed.get('mcp.alpha').tools;
  assert.equal(exposed.replay, 'safe');
  await exposed.execute({}, { conversationId: 1 }, {});
  assert.deepEqual(received, ['alpha.lookup']);
});

test('a server whose first connection failed is connected by a later ready(), at most once per 30 seconds', async t => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const manager = fakeManager(), rows = [];
  let attempts = 0;
  manager.listServers = () => rows;
  manager.registerServer = async id => { rows.push({ id }); manager.mcpConnections[id] = { connectionState: 'connecting' }; };
  manager.connectToServer = async id => {
    attempts++;
    if (attempts === 1) { manager.mcpConnections[id].connectionState = 'failed'; return { state: 'failed', error: 'fictional outage' }; }
    manager.mcpConnections[id].connectionState = 'connected';
    return { state: 'connected' };
  };
  manager.discoverIfConnected = async id => { manager.mcpConnections[id].connectionState = 'ready'; manager.tools[id] = FRESH; };
  const { mcp, registry } = services({ servers: [{ id: 'alpha', url: 'https://fixture.invalid/mcp', allow: 'all' }], manager });
  await mcp.restore();
  await mcp.ready();
  assert.equal(manager.mcpConnections.alpha.connectionState, 'failed');
  await mcp.ready();
  assert.equal(attempts, 1, 'no retry inside the backoff');
  mock.timers.tick(30_000);
  await mcp.ready();
  assert.equal(attempts, 2);
  assert.equal(mcp.status()[0].state, 'ready');
  assert.deepEqual(registry.toolsOf('mcp.alpha'), ['alpha__new_search', 'alpha__new_send']);
});

test('connect_service renews a stored sign-in link whose OAuth state expired instead of returning it forever', async () => {
  const manager = fakeManager(), rows = [], issued = new Set();
  let nonce = 0;
  manager.listServers = () => rows;
  // The provider's public checkState: a state is valid while the provider still holds it (expiry removes it).
  const authProvider = { checkState: async state => ({ valid: issued.has(state) }) };
  manager.registerServer = async id => { rows.push({ id }); manager.mcpConnections[id] = { connectionState: 'connecting', options: { transport: { authProvider } } }; };
  manager.connectToServer = async id => {
    const state = `n${++nonce}.${id}`;
    issued.add(state);
    rows[0].auth_url = `https://auth.fixture.invalid/authorize?state=${state}`;
    manager.mcpConnections[id].connectionState = 'authenticating';
    return { state: 'authenticating', authUrl: rows[0].auth_url };
  };
  const { mcp } = services({ servers: [{ id: 'alpha', url: 'https://fixture.invalid/mcp', allow: 'all', oauth: true }], manager, origin: 'https://app.fixture.invalid' });
  await mcp.restore();
  await mcp.ready(); // registration issues the first link
  const connect = mcp.servicesExtension.tools.find(item => item.name === 'connect_service');
  const run = async () => (await connect.execute({ id: 'alpha' }, { conversationId: 1 }, {})).content[0].text;
  assert.match(await run(), /state=n1\.alpha$/, 'a link still valid is returned as is');
  issued.delete('n1.alpha'); // ten minutes later the provider no longer accepts it
  assert.match(await run(), /state=n2\.alpha$/);
});
