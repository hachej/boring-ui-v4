// AWS host recipe: the standard agent (../shared/standard-agent.mjs) behind the AgentCore Runtime HTTP contract
// (`GET /ping`, `POST /invocations` on 0.0.0.0:8080). The same process runs as a plain ECS service behind a load balancer.
//
// Per user (the verified token's `sub`, mapped by the host to a POSIX uid and an EFS access point):
//   - the workspace is the user's folder on the shared EFS file system: `/mnt/efs/users/<id>` here, `/mnt/workspace`
//     inside the user's Code Interpreter session (its own access point, root `/users/<id>`): the same files on both sides;
//   - commands run in that Code Interpreter session (`@boring/execution/aws-code-interpreter`), files are read and written
//     on this host's mount, and the workspace provider (viewer, `present`, the file guard) reads the same folder;
//   - the harness (one SQLite file per conversation key) and the provider's journal live in `/mnt/efs/state/<id>`, which
//     the interpreter cannot reach. One writer per SQLite file: one AgentCore session per conversation key (decision 1 of
//     docs/architecture/HOST-RECIPE-AWS.md), or a single ECS task. Every SQLite file on EFS is opened with
//     `sqliteSettings.networkFilesystem` (rollback journal, lock held from open to close, full sync; never WAL on NFS), Pi's
//     harness files included (`openPiStorage`); a second opener of a held file gets `SqliteLockedError`, not a shared write.
//
// `POST /invocations` carries one chat transport operation in its JSON body, because AgentCore routes only that path:
//   { op: 'watch' | 'entries' | 'submission', conversation?: 'main', params?: { ... } }          read operations
//   { op: 'submit' | 'abort' | 'answer' | 'configure' | 'withdraw', conversation?, input: { ... } }   effects
//   { op: 'files' } and { op: 'file', params: { path } }                                     the workspace as the viewer reads it
// Fictional content only. Nothing here creates AWS resources or credentials; see ./README.md.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { answerUserQuestion } from '@boring/agent/ask-user';
import { createChatTransportHandler } from '@boring/agent/chat-transport';
import { openNodeConnection, sqliteSettings } from '@boring/files/sqlite';
import { createWorkspaceJournal } from '@boring/files/journal';
import { createWorkspaceProvider, isTemporary } from '@boring/files/workspace';
import { createCodeInterpreterEnv, efsUserLayout } from '@boring/execution/aws-code-interpreter';
import { defineStandardAgent } from '../shared/standard-agent.mjs';
import { openPiStorage } from '../shared/pi-storage.mjs';
import { readFiles, shell, writeFiles } from '../shared/workspace-tools.mjs';
import { configureOffered } from '../shared/conversation-host.mjs';
import { sendWebResponse, webRequest } from '@boring/files/node-http';
import { createJwtVerifier } from './jwt.mjs';

const READS = new Set(['watch', 'entries', 'submission']), EFFECTS = new Set(['submit', 'abort', 'answer', 'configure', 'withdraw']);
const KEY = /^[a-z0-9_-]{1,64}$/;
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

/** The AgentCore `runtimeSessionId` of one user's conversation key: a client sends it, the host checks it (single writer). */
export const runtimeSessionId = (userId, key) => `boring-${createHash('sha256').update(`${userId}\n${key}`).digest('hex').slice(0, 48)}`;

/**
 * @param {object} options
 * @param {(claims: object) => Promise<{ userId: string, uid: number, accessPointArn: string, fileSystemArn: string } | null>} options.users host policy: who may use the agent, and their folder
 * @param {(token: string) => Promise<object | null>} options.verifyToken
 * @param {{ client: object, identifier: string, sessionTimeoutSeconds?: number, pollIntervalMs?: number }} options.codeInterpreter
 */
export async function startAwsHost({ port = 8080, hostname = '0.0.0.0', efsRoot = '/mnt/efs', interpreterMountPath = '/mnt/workspace', users, verifyToken,
  codeInterpreter, models, model, offered = [model], requireSessionHeader = false, sqlite = sqliteSettings.networkFilesystem }) {
  const perUser = new Map(), conversations = new Map();
  const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

  async function userOf(entry) {
    const known = perUser.get(entry.userId);
    if (known) return known;
    const layout = efsUserLayout({ userId: entry.userId, uid: entry.uid, runtimeMountPath: efsRoot, interpreterMountPath });
    // The folder may exist already (the access point creates it on the interpreter's first mount); either way it keeps the
    // shared group with setgid, so files written on either side stay writable by the other (umask 002 on both).
    mkdirSync(layout.runtime.root, { recursive: true }); chmodSync(layout.runtime.root, 0o2770);
    mkdirSync(layout.runtime.state, { recursive: true, mode: 0o700 });
    const interpreter = createCodeInterpreterEnv({ client: codeInterpreter.client, codeInterpreterIdentifier: codeInterpreter.identifier, id: layout.namespaceId,
      session: { start: { name: `boring-${entry.userId}`.slice(0, 48), sessionTimeoutSeconds: codeInterpreter.sessionTimeoutSeconds ?? 3600,
        filesystemConfigurations: [layout.filesystemConfiguration({ accessPointArn: entry.accessPointArn, fileSystemArn: entry.fileSystemArn })] } },
      mount: { path: layout.interpreter.mountPath, root: layout.runtime.root },
      ...(codeInterpreter.pollIntervalMs ? { pollIntervalMs: codeInterpreter.pollIntervalMs } : {}) });
    const database = openNodeConnection(layout.runtime.journal, sqlite);
    const files = createWorkspaceProvider({ identity: { providerId: 'workspace', instanceId: layout.namespaceId, incarnation: 'aws', viewId: 'published' }, fs: interpreter.env, journal: createWorkspaceJournal(database) });
    const access = { scopeId: entry.userId, principalId: 'agent', initiatorId: entry.userId };
    const { agent, capabilities } = defineStandardAgent({ id: 'standard-aws', model, cwd: layout.interpreter.cwd, root: layout.interpreter.mountPath, files, access,
      parts: [{ capabilities: ['workspace'], extensions: [readFiles, writeFiles] }, { capabilities: ['shell'], extensions: [shell] }] });
    const registry = createRegistry();
    agent.install(registry);
    const user = { userId: entry.userId, layout, interpreter, files, agent, capabilities, registry, database };
    perUser.set(entry.userId, user);
    return user;
  }

  /** One harness per conversation key and one root conversation in it: the file has a single writer, this session. */
  async function conversationOf(user, key) {
    const id = `${user.userId}/${key}`;
    const known = conversations.get(id);
    if (known) return known;
    const opening = (async () => {
      const harness = await Harness.open(await openPiStorage(user.layout.harnessFile(key), sqlite), { registry: user.registry, models, env: () => user.interpreter.env }, context);
      const conversation = await harness.root(context, { agent: user.agent.agent });
      harness.resume();
      return { harness, conversation };
    })();
    conversations.set(id, opening);
    opening.catch(() => conversations.delete(id));
    return opening;
  }

  // /ping: HealthyBusy while a harness has live tasks or unsettled submissions, so AgentCore keeps the session past its idle
  // timeout. `time_of_last_update` changes only when the status does (a timestamp that moves on every ping keeps a session alive forever).
  let status = 'Healthy', changedAt = Math.floor(Date.now() / 1000);
  async function ping() {
    let busy = false;
    for (const opening of conversations.values()) {
      const opened = await opening.catch(() => undefined);
      const inspection = opened && await opened.harness.inspect(context);
      if (inspection && (inspection.tasks.length > 0 || inspection.submissions.length > 0)) { busy = true; break; }
    }
    const next = busy ? 'HealthyBusy' : 'Healthy';
    if (next !== status) { status = next; changedAt = Math.floor(Date.now() / 1000); }
    return json({ status, time_of_last_update: changedAt });
  }

  const granted = new WeakMap();
  const chat = createChatTransportHandler({ authenticate: async request => granted.get(request) ?? null });

  async function walk(env, path, prefix = '') {
    const found = [];
    const listed = await env.listDir(path, context);
    if (!listed.ok) return found;
    for (const entry of listed.value.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || isTemporary(entry.name)) continue;
      if (entry.kind === 'directory') found.push(...await walk(env, entry.path, `${prefix}${entry.name}/`));
      else if (entry.kind === 'file') found.push(`${prefix}${entry.name}`);
    }
    return found;
  }

  async function invocations(request) {
    const token = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    const claims = token ? await verifyToken(token) : null;
    if (!claims) return json({ reason: 'authentication-required' }, 401);
    const entry = await users(claims);
    if (!entry) return json({ reason: 'not-authorized' }, 403);
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return json({ reason: 'unsupported-media-type' }, 415);
    let body;
    try { body = await request.json(); } catch { return json({ reason: 'invalid-json' }, 400); }
    const { op, conversation: key = 'main', params = {}, input = {} } = body ?? {};
    if (typeof op !== 'string' || !KEY.test(key) || typeof params !== 'object' || params === null || Object.values(params).some(value => typeof value !== 'string')) return json({ reason: 'invalid-request' }, 400);
    // One AgentCore session per conversation key: a request routed to another session's microVM is refused, never served.
    const session = request.headers.get(SESSION_HEADER), expected = runtimeSessionId(entry.userId, key);
    if (session ? session !== expected : requireSessionHeader) return json({ reason: 'session-mismatch' }, 409);
    const user = await userOf(entry);
    // An expired interpreter session was reported to the running command as lost; the next request starts a new one.
    if (user.interpreter.lost() && user.interpreter.renew()) console.error(`code interpreter session of ${user.userId} was lost; the next command starts a new one`);
    if (op === 'files') return json({ files: await walk(user.interpreter.env, user.layout.interpreter.mountPath) });
    if (op === 'file') {
      const path = params.path ?? '';
      if (!path || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '')) return json({ reason: 'invalid-path' }, 400);
      const read = await user.files.read({ target: { resource: { providerId: 'workspace', path }, view: { kind: 'published' } }, revision: { kind: 'latest' } }, { scopeId: user.userId, principalId: user.userId, initiatorId: user.userId });
      if (read.kind !== 'available') return json({ reason: 'not-found' }, 404);
      return json({ path, size: read.snapshot.bytes.byteLength, text: new TextDecoder().decode(read.snapshot.bytes) });
    }
    if (!READS.has(op) && !EFFECTS.has(op)) return json({ reason: 'unknown-operation' }, 404);
    const { harness, conversation } = await conversationOf(user, key);
    const url = `http://aws.invalid/chat?${new URLSearchParams({ ...params, op })}`;
    const inner = READS.has(op) ? new Request(url, { method: 'GET', signal: request.signal })
      : new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: request.signal });
    granted.set(inner, { conversation, context,
      abortSubmission: id => harness.abortSubmission(id, context, conversation.id),
      answer: (callId, answer) => answerUserQuestion(conversation, callId, answer, context),
      configure: change => configureOffered(conversation, change, context, candidate => offered.some(item => item.provider === candidate.provider && item.modelId === candidate.modelId)) });
    return chat(inner);
  }

  const server = createServer(async (incoming, outgoing) => {
    const closed = new AbortController();
    outgoing.on('close', () => closed.abort());
    try {
      const url = new URL(incoming.url, 'http://aws.invalid');
      let response;
      if (incoming.method === 'GET' && url.pathname === '/ping') response = await ping();
      else if (incoming.method === 'POST' && url.pathname === '/invocations') {
        const request = await webRequest(incoming, url, { signal: closed.signal, maxBytes: 8 * 1024 * 1024 });
        response = request ? await invocations(request) : json({ reason: 'too-large' }, 413);
      } else response = json({ reason: 'not-found' }, 404);
      await sendWebResponse(response, outgoing, { signal: closed.signal });
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
      if (!closed.signal.aborted) console.error('request failed:', error?.message ?? error);
    }
  });
  await new Promise(resolve => server.listen(port, hostname, resolve));
  return {
    url: `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${server.address().port}`, perUser, conversations,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      for (const opening of conversations.values()) await (await opening.catch(() => undefined))?.harness.close(context);
      for (const user of perUser.values()) { await user.interpreter.stop(context).catch(() => {}); user.database.close(); }
    },
  };
}

// ---- The container entry (AgentCore Runtime or ECS). Configuration comes from the environment; see ./README.md.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const need = name => { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; };
  // Files written here stay group-writable for the user's interpreter session (efsUserLayout: shared gid, setgid folders).
  process.umask(0o002);
  const efsRoot = process.env.EFS_ROOT ?? '/mnt/efs';
  // users.json: { "<sub>": { "uid": 2001, "accessPointArn": "...", "fileSystemArn": "..." } }, written when a user is provisioned.
  const usersFile = process.env.USERS_FILE ?? `${efsRoot}/state/users.json`;
  const users = async claims => {
    if (typeof claims.sub !== 'string' || !existsSync(usersFile)) return null;
    const entry = JSON.parse(readFileSync(usersFile, 'utf8'))[claims.sub];
    return entry ? { userId: claims.sub, ...entry } : null;
  };
  const { BedrockAgentCoreClient } = await import('@aws-sdk/client-bedrock-agentcore');
  const provider = process.env.MODEL_PROVIDER ?? 'amazon-bedrock';
  const models = createModels();
  models.setProvider(provider === 'amazon-bedrock' ? (await import('@earendil-works/pi-ai/providers/amazon-bedrock')).amazonBedrockProvider()
    : provider === 'anthropic' ? (await import('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider()
      : (await import('@earendil-works/pi-ai/providers/openai')).openaiProvider());
  const app = await startAwsHost({
    port: Number(process.env.PORT ?? 8080), efsRoot, users, models, model: { provider, modelId: need('MODEL_ID') },
    // OIDC_JWKS (the key set inline) serves a VPC without internet egress; OIDC_JWKS_URL is fetched and refreshed on key rotation.
    verifyToken: createJwtVerifier({ issuer: need('OIDC_ISSUER'), audience: need('OIDC_AUDIENCE'),
      ...(process.env.OIDC_JWKS ? { jwks: JSON.parse(process.env.OIDC_JWKS) } : { jwksUrl: need('OIDC_JWKS_URL') }) }),
    // The task role supplies credentials through the default provider chain; nothing is configured here.
    codeInterpreter: { client: new BedrockAgentCoreClient({ region: process.env.REGION ?? need('AWS_REGION') }), identifier: need('CODE_INTERPRETER_ID') },
    requireSessionHeader: process.env.AGENTCORE === '1',
  });
  console.log(`AWS host on ${app.url} (EFS ${efsRoot}, ${process.env.AGENTCORE === '1' ? 'AgentCore Runtime' : 'ECS'} mode).`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().finally(() => process.exit(0)); });
}
