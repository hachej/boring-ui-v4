// Credits: in the local variant every message is metered (@boring/agent/metering, examples/studio/server.mjs): it is reserved against the
// person's fictional balance before it reaches the conversation and charged its usage when it ends. An exhausted balance refuses the next
// message with the ledger's own words, and the model is never called. The scenario tops the balance back up at the end.
import assert from 'node:assert/strict';

const credits = async t => (await t.api('/api/credits')).json();
let before, spent;

export default {
  id: 'chat-credits', group: 'Chat basics', title: 'Spend credits until refused', variants: ['local'],
  description: 'Messages spend fictional credits; when they run out the next message is refused with a clear notice.',
  steps: [
    { async run(t) { before = await credits(t); assert.ok(before.availableMicros > before.holdMicros, 'the scenario starts with credits'); } },
    { prompt: 'Reply with exactly: CREDITS-ONE' },
    { async run(t) {
      spent = await credits(t);
      assert.ok(spent.balanceMicros < before.balanceMicros, `the message was charged (${before.balanceMicros} -> ${spent.balanceMicros})`);
      assert.equal(spent.heldMicros, 0, 'nothing is held once the message is answered');
    } },
    // The scripted model reports a billion input tokens for this turn: more than the whole fictional balance.
    { prompt: 'Spend all my credits: reply with exactly: CREDITS-DRAINED' },
    { async run(t) {
      try {
        const drained = await credits(t);
        assert.ok(drained.availableMicros < drained.holdMicros, `the balance is exhausted (${drained.availableMicros})`);
        const users = await t.browser.evaluate(`${t.userMessages}.length`);
        await t.say('Reply with exactly: CREDITS-REFUSED');
        await t.browser.until('the refusal is shown', `/Not enough credits/.test(${t.q('[data-testid=send-blocked]')}?.textContent ?? '')`, 20000);
        await t.pause(1000);
        assert.equal(await t.browser.evaluate(`${t.userMessages}.length`), users, 'the refused message never reached the conversation');
        assert.equal(await t.browser.evaluate(t.idle), true, 'nothing runs');
        await t.shots?.('chatui-credits-refused');
      } finally {
        await t.api('/api/credits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        await t.clear();
      }
    } },
  ],
  script: { 3: [{ text: 'CREDITS-DRAINED', usage: { input: 1_000_000_000, output: 1 } }] },
  expect: [{ reply: /CREDITS-ONE/ }, { reply: /CREDITS-DRAINED/ }, { replyNot: /CREDITS-REFUSED/ }],
};
