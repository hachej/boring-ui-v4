// Offline journey of the AWS recipe: no AWS account, no model key. The real host (./server.mjs) runs over a temporary
// directory standing for the EFS file system, the fake Code Interpreter (./fake-code-interpreter.mjs) answers the real
// AWS SDK client, tokens are signed by a fictional key pair, and the scripted model (../studio/scripted-model.mjs) drives
// the standard agent's real tools. It proves, through POST /invocations:
//   - the agent's write tool (runtime side) and a bash command (interpreter session) work on the same folder, and the
//     workspace provider (the viewer's read) sees the command's change;
//   - two users never see each other's folders: separate access points, folder-confined file tools, separate listings;
//   - an expired interpreter session is reported lost to the command, and the next request starts a new session;
//   - bearer, user and session checks, and /ping;
//   - every SQLite file in the state folder (journal, Pi harness) uses `sqliteSettings.networkFilesystem`: rollback journal,
//     no WAL file, and held by its one owner, so a second opener gets `SqliteLockedError`.
//   - the per-owner harness pool: one harness per user and conversation key, closed once idle, reopened with its history.
// Run: npm run build && node examples/aws/journey.mjs
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { SqliteLockedError, openNodeConnection } from '@boring/files/sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptedModels } from '../studio/scripted-model.mjs';
import { startFakeCodeInterpreter } from './fake-code-interpreter.mjs';
import { createJwtVerifier } from './jwt.mjs';
import { runtimeSessionId, startAwsHost } from './server.mjs';

const call = (name, args) => ({ tools: [{ name, args }] });
const SCRIPT = [{ name: 'aws journey', entries: Object.entries({
  'Shared folder check': [
    call('write', { path: 'notes/plan.md', content: '# Harbour plan\n\n- status: draft\n' }),
    call('bash', { command: "sed -i 's/draft/reviewed in the interpreter/' notes/plan.md && cat notes/plan.md && pwd" }),
    ctx => `Interpreter output:\n${ctx.last.text.trim()}`,
  ],
  'Neighbour check': [
    call('read', { path: '../user-a/notes/plan.md' }),
    call('read', { path: '/mnt/efs/users/user-a/notes/plan.md' }),
    call('bash', { command: 'ls -A /mnt/workspace; cat notes/plan.md 2>&1 || echo NO-PLAN-HERE' }),
    ctx => `Done: ${ctx.last.text.trim()}`,
  ],
  'After expiry': [call('bash', { command: 'echo still-here' }), ctx => `Result: ${ctx.last.text.trim()}`],
  'After renewal': [call('bash', { command: 'cat notes/plan.md' }), ctx => `Result: ${ctx.last.text.trim()}`],
}).map(([match, turns]) => ({ match, turns })) }];

const efs = mkdtempSync(join(tmpdir(), 'boring-aws-efs-'));
const ARN = user => `arn:aws:elasticfilesystem:us-east-1:000000000000:access-point/fsap-${user === 'user-a' ? 'aaaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbbb'}`;
const FILE_SYSTEM = 'arn:aws:elasticfilesystem:us-east-1:000000000000:file-system/fs-00000000000000000';
const USERS = { 'user-a': { uid: 2001 }, 'user-b': { uid: 2002 } };
// The fake's access points are the users' folders, exactly where the runtime sees them under its own mount.
const fake = await startFakeCodeInterpreter({ accessPoints: Object.fromEntries(Object.keys(USERS).map(user => [ARN(user), join(efs, 'users', user)])) });

// A fictional OIDC issuer: one RSA key, tokens signed here.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ISSUER = 'https://issuer.example.invalid', AUDIENCE = 'fictional-client';
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(sub, { key = privateKey, issuer = ISSUER } = {}) {
  const head = `${encode({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${encode({ sub, iss: issuer, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}

const { models, misses } = await createScriptedModels({ sources: SCRIPT });
const app = await startAwsHost({ port: 0, hostname: '127.0.0.1', efsRoot: efs, models, model: { provider: 'openai', modelId: 'gpt-5-mini' },
  users: async claims => USERS[claims.sub] ? { userId: claims.sub, uid: USERS[claims.sub].uid, accessPointArn: ARN(claims.sub), fileSystemArn: FILE_SYSTEM } : null,
  verifyToken: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks }),
  codeInterpreter: { client: await fake.client(), identifier: fake.codeInterpreterIdentifier, pollIntervalMs: 50 },
  requireSessionHeader: true, harnessIdleMs: 1500 });

const invoke = (user, body, { bearer = token(user), session = runtimeSessionId(user, body.conversation ?? 'main') } = {}) => fetch(`${app.url}/invocations`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(session ? { 'x-amzn-bedrock-agentcore-runtime-session-id': session } : {}) },
});
const ok = async response => { assert.equal(response.status, 200, `${response.status} ${await response.clone().text()}`); return response.json(); };
const until = async (what, check, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error(`Timed out: ${what}`); await new Promise(resolve => setTimeout(resolve, 100)); }
};
/** Submits a prompt and waits until the conversation is idle again, then returns the tool results and the last answer. */
async function turn(user, prompt) {
  await ok(await invoke(user, { op: 'submit', input: { requestId: randomUUID(), content: prompt } }));
  await until(`${user} idle`, async () => { const { status } = await (await fetch(`${app.url}/ping`)).json(); statuses.add(status); return status === 'Healthy'; });
  const { page } = await ok(await invoke(user, { op: 'entries', params: { limit: '50' } }));
  // Pages are newest first.
  const messages = [...page.items].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).flatMap(entry => entry.model ?? []);
  const results = messages.filter(message => message.role === 'toolResult').map(message => ({ name: message.toolName, isError: message.isError, text: message.content.map(part => part.text ?? '').join('') }));
  const answer = messages.filter(message => message.role === 'assistant').flatMap(message => message.content).filter(part => part.type === 'text').map(part => part.text).join('');
  return { results, answer };
}
const steps = [], statuses = new Set();
const step = async (name, run) => { const started = Date.now(); await run(); steps.push(name); console.log(`ok  ${name} (${Date.now() - started} ms)`); };

try {
  await step('/ping answers Healthy with a stable time_of_last_update', async () => {
    const first = await (await fetch(`${app.url}/ping`)).json(), second = await (await fetch(`${app.url}/ping`)).json();
    assert.equal(first.status, 'Healthy'); assert.equal(first.time_of_last_update, second.time_of_last_update);
  });
  await step('a missing or forged bearer is 401, an unknown user 403, another session 409', async () => {
    assert.equal((await invoke('user-a', { op: 'files' }, { bearer: '' })).status, 401);
    assert.equal((await invoke('user-a', { op: 'files' }, { bearer: token('user-a', { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }) })).status, 401);
    assert.equal((await invoke('user-a', { op: 'files' }, { bearer: token('user-a', { issuer: 'https://other.example.invalid' }) })).status, 401);
    assert.equal((await invoke('user-c', { op: 'files' })).status, 403);
    assert.equal((await invoke('user-a', { op: 'files' }, { session: runtimeSessionId('user-a', 'other') })).status, 409);
    assert.equal((await invoke('user-a', { op: 'files' }, { session: '' })).status, 409);
  });
  await step('user A: the write tool and an interpreter command change the same file, and the viewer reads the change', async () => {
    const { results, answer } = await turn('user-a', 'Shared folder check: write the plan, then review it in the interpreter.');
    assert.deepEqual(results.map(result => [result.name, result.isError]), [['write', false], ['bash', false]]);
    assert.match(results[1].text, /status: reviewed in the interpreter/);
    assert.match(results[1].text, /^\/mnt\/workspace$/m, 'the command ran in the interpreter mount');
    assert.match(answer, /reviewed in the interpreter/);
    const { files } = await ok(await invoke('user-a', { op: 'files' }));
    assert.deepEqual(files, ['notes/plan.md']);
    const { text } = await ok(await invoke('user-a', { op: 'file', params: { path: 'notes/plan.md' } }));
    assert.equal(text, '# Harbour plan\n\n- status: reviewed in the interpreter\n');
    const started = fake.calls.filter(item => item.operation === 'StartCodeInterpreterSession');
    assert.deepEqual(started.map(item => item.filesystemConfigurations), [[{ efsConfiguration: { accessPointArn: ARN('user-a'), fileSystemArn: FILE_SYSTEM, mountPath: '/mnt/workspace' } }]]);
  });
  await step('user B never sees user A\'s folder: own access point, file tools confined, empty listing', async () => {
    const { results } = await turn('user-b', 'Neighbour check: try to read the other plan.');
    assert.deepEqual(results.map(result => [result.name, result.isError]), [['read', true], ['read', true], ['bash', false]]);
    for (const refused of results.slice(0, 2)) assert.match(refused.text, /Outside the workspace/);
    assert.match(results[2].text, /NO-PLAN-HERE/);
    assert.doesNotMatch(results[2].text, /Harbour plan/);
    assert.deepEqual((await ok(await invoke('user-b', { op: 'files' }))).files, []);
    assert.equal((await invoke('user-b', { op: 'file', params: { path: 'notes/plan.md' } })).status, 404);
    assert.equal((await invoke('user-b', { op: 'file', params: { path: '../user-a/notes/plan.md' } })).status, 400);
    const started = fake.calls.filter(item => item.operation === 'StartCodeInterpreterSession').map(item => item.filesystemConfigurations[0].efsConfiguration.accessPointArn);
    assert.deepEqual(started, [ARN('user-a'), ARN('user-b')]);
  });
  await step('an expired interpreter session is reported lost; the next request starts a new one on the same files', async () => {
    const before = app.perUser.get('user-a').interpreter.sessionId();
    fake.expire(before);
    const lost = await turn('user-a', 'After expiry: echo something.');
    const bash = lost.results.filter(result => result.name === 'bash').at(-1);
    assert.equal(bash.isError, true); assert.match(bash.text, /ResourceNotFoundException|gone/);
    const renewed = await turn('user-a', 'After renewal: show the plan again.');
    assert.match(renewed.results.at(-1).text, /reviewed in the interpreter/);
    assert.notEqual(app.perUser.get('user-a').interpreter.sessionId(), before);
  });
  await step('the state files on EFS use the network file system preset: rollback journal, one owner holding each file', async () => {
    // Held, so the idle pool keeps user A's harness (and its lock) open during the check.
    const lease = await app.harnesses.acquire('user-a/main');
    const user = app.perUser.get('user-a');
    assert.equal(user.database.get('PRAGMA journal_mode').journal_mode, 'delete');
    assert.equal(user.database.get('PRAGMA locking_mode').locking_mode, 'exclusive');
    const state = readdirSync(user.layout.runtime.state).sort();
    assert.ok(state.includes('journal.sqlite') && state.some(name => name.endsWith('.pi.sqlite')), state.join(', '));
    assert.deepEqual(state.filter(name => /-(wal|shm)$/.test(name)), [], 'no WAL or shared-memory file on EFS');
    for (const file of [user.layout.runtime.journal, user.layout.harnessFile('main')]) {
      assert.ok(existsSync(file));
      assert.throws(() => openNodeConnection(file, { busyTimeoutMs: 100 }), SqliteLockedError, `${file} is held by its owner`);
    }
    lease.release();
  });
  await step('per-owner pool: one harness per user and key, never shared; idle ones close; the next request reopens with the history', async () => {
    const opened = await app.harnesses.opened();
    assert.ok(opened.length <= 2 && new Set(opened.map(item => item.harness)).size === opened.length, 'one harness per owner');
    await until('every idle harness closed', () => app.harnesses.owners().length === 0);
    openNodeConnection(app.perUser.get('user-a').layout.harnessFile('main'), { busyTimeoutMs: 100 }).close(); // the close released the file's lock
    const renewed = await turn('user-a', 'After renewal: the plan once more, from a reopened harness.');
    assert.match(renewed.results.at(-1).text, /reviewed in the interpreter/);
    assert.deepEqual(app.harnesses.owners(), ['user-a/main']);
    const { page } = await ok(await invoke('user-a', { op: 'entries', params: { limit: '50' } }));
    const users = page.items.flatMap(entry => entry.model ?? []).filter(message => message.role === 'user').map(message => JSON.stringify(message.content));
    assert.ok(users.some(text => text.includes('Shared folder check')), 'the conversation kept its history across the close');
    await ok(await invoke('user-b', { op: 'files' }));
    assert.deepEqual(app.harnesses.owners(), ['user-a/main'], 'a file listing opens no harness');
  });
  assert.ok(statuses.has('HealthyBusy'), '/ping reported HealthyBusy while a turn ran');
  assert.deepEqual(misses, [], 'every model turn was scripted');
  console.log(`AWS recipe journey: ${steps.length} steps passed (offline: fake Code Interpreter, fictional issuer, scripted model).`);
} finally {
  await app.close();
  await fake.close();
}
