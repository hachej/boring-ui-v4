import assert from 'node:assert/strict';
import test from 'node:test';
import { composioPolicy, READ_TOOLS } from '../../examples/cloudflare/src/composio-policy.mjs';

const policy = composioPolicy();
const execute = { name: 'COMPOSIO_MULTI_EXECUTE_TOOL' };
const run = (...slugs) => ({ tools: slugs.map(tool_slug => ({ tool_slug, arguments: {} })) });

test('only reviewed reads run without asking; a "find" that writes asks', () => {
  assert.equal(policy.approveCall(execute, run('GMAIL_FETCH_EMAILS', 'GMAIL_LIST_THREADS')), false);
  assert.equal(policy.approveCall(execute, run('GOOGLESHEETS_FIND_REPLACE')), true, 'the review example: finds and replaces');
  assert.equal(policy.approveCall(execute, run('GITHUB_LIST_REPOSITORIES')), true, 'unreviewed reads ask until added');
  assert.equal(policy.approveCall(execute, run('GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL')), true, 'one write in a batch asks');
  assert.equal(policy.approveCall(execute, {}), true);
  assert.equal(policy.approveCall(execute, run()), true);
  assert.equal(composioPolicy(['GITHUB_LIST_REPOSITORIES']).approveCall(execute, run('GITHUB_LIST_REPOSITORIES')), false, 'host can add reviewed reads');
  assert.ok(!READ_TOOLS.has('GMAIL_SEND_EMAIL'));
});

test('the host, not annotations, decides reads; connect links do not ask but are never replayed as reads', () => {
  assert.equal(policy.readOnly({ name: 'COMPOSIO_SEARCH_TOOLS' }), true);
  assert.equal(policy.readOnly({ name: 'COMPOSIO_MULTI_EXECUTE_TOOL', annotations: { readOnlyHint: true } }), false);
  assert.equal(policy.approve({ name: 'COMPOSIO_MANAGE_CONNECTIONS' }), false);
  assert.equal(policy.readOnly({ name: 'COMPOSIO_MANAGE_CONNECTIONS' }), false);
  assert.equal(policy.approve(execute), true);
  assert.match(policy.summarize(execute, { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'x@example.invalid' } }] }), /^Run GMAIL_SEND_EMAIL \{"to":"x@example.invalid"\}/);
});
