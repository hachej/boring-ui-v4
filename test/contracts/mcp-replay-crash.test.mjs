import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// An MCP call that may have changed something upstream is never run twice: when the process dies after the upstream effect
// and before Pi records the tool result, recovery reports an unknown outcome. Only a host-declared read replays.
const script = fileURLToPath(new URL('../fixtures/mcp-replay-crash-child.mjs', import.meta.url));
const modes = {
  gated: 'an approved write',
  annotated: 'an approved write the server annotates readOnlyHint',
  exempted: 'a write whose call approveCall exempts from the question',
  'host-read': 'a host-declared read (control: it replays)',
};
for (const [mode, label] of Object.entries(modes)) {
  test(`MCP replay after SIGKILL during the upstream call: ${label}`, { timeout: 30000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'boring-mcp-crash-'));
    const workers = [];
    function start(phase) {
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, [script, directory, phase, mode], { env, stdio: ['ignore', 'inherit', 'inherit'] });
      const terminal = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
      terminal.catch(() => {});
      const worker = { child, terminal }; workers.push(worker); return worker;
    }
    t.after(async () => { for (const worker of workers) { worker.child.kill('SIGKILL'); await worker.terminal.catch(() => {}); } rmSync(directory, { recursive: true, force: true }); });
    const first = start('hold');
    await Promise.race([
      first.terminal.then(result => { throw new Error(`Early exit ${JSON.stringify(result)}`); }),
      (async () => { const until = Date.now() + 15000; while (!existsSync(join(directory, 'ready.json'))) { if (Date.now() > until) throw new Error('MCP call checkpoint timeout'); await delay(10); } })(),
    ]);
    first.child.kill('SIGKILL');
    assert.deepEqual(await first.terminal, { code: null, signal: 'SIGKILL' });
    const next = start('recover');
    assert.deepEqual(await next.terminal, { code: 0, signal: null });
    const recovered = JSON.parse(readFileSync(join(directory, 'recovered.json'), 'utf8'));
    assert.equal(recovered.status, 'done', 'the turn finishes after the reopen');
    assert.equal(recovered.results.length, 1);
    if (mode === 'host-read') {
      assert.equal(recovered.effects.length, 2, 'a host-declared read runs again');
      assert.deepEqual(recovered.results[0], { isError: false, text: 'search_mail done' });
    } else {
      assert.deepEqual(recovered.effects, ['hold send_mail {"to":"fictional@example.invalid"}'], 'the upstream write happened once and is not repeated');
      assert.equal(recovered.results[0].isError, true);
      assert.match(recovered.results[0].text, /process stopped while it ran\. Whether the change was applied is unknown/);
    }
  });
}
