// Fake-model Chromium gate. No credentials, external model requests or consumer applications.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from './server.mjs';
import { launch } from './driver.mjs';
import { createCorrectnessFixture } from './correctness-fixture.mjs';

const evidence = process.env.STUDIO_EVIDENCE ?? '.cache/evidence/studio-correctness';
mkdirSync(evidence, { recursive: true });
const report = { head: null, dirty: null, model: 'fictional local provider', status: 'running', steps: [] };
const git = args => {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
  catch (error) {
    if (error.status === 0 && typeof error.stdout === 'string') { report.metadataWarning = String(error); return error.stdout.trim(); }
    throw error;
  }
};
const directory = mkdtempSync(join(tmpdir(), 'boring-correctness-'));
const step = async (name, run) => {
  const result = { name, status: 'running', started: Date.now() }; report.steps.push(result);
  try { await run(); result.status = 'passed'; } catch (error) { result.status = 'failed'; result.error = String(error); throw error; }
  finally { result.ms = Date.now() - result.started; }
};
const fixture = createCorrectnessFixture();
const { models, model, transcripts } = fixture;
const encode = text => new TextEncoder().encode(text);
let app, browser;
const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
const button = text => `[...document.querySelectorAll('button')].find(element => element.textContent.trim() === ${JSON.stringify(text)})`;
const source = q('[data-testid=workspace-panel] textarea');
const status = q('[data-testid=viewer-status]');
let notes;
const openDocument = async () => {
  // The document is a file of the workspace: open notes.md from the Files list.
  await browser.until('the studio is up', `!!${q('[data-testid=studio-panel-open]')} || !!${q('[data-testid=workspace-panel]')}`);
  if (!await browser.evaluate(`!!${q('[data-testid=workspace-panel]')}`)) await browser.click(q('[data-testid=studio-panel-open]'));
  const notesButton = `[...document.querySelectorAll('.studio-panel li button')].find(b => b.textContent === 'notes.md')`;
  await browser.until('notes.md is listed', `!!${notesButton}`);
  await browser.click(notesButton);
  await browser.until('document panel opened', `!!${q('[data-testid=viewer-mode-source]')}`);
  await browser.click(q('[data-testid=viewer-mode-source]'));
  await browser.until('source editor loaded', `!!${source}`);
};
const saved = async () => {
  const value = await app.files.read({ target: notes, revision: { kind: 'latest' } }, app.host.agentAccess);
  assert.equal(value.kind, 'available'); return value.snapshot;
};
const savedText = async () => new TextDecoder().decode((await saved()).bytes);
try {
  report.head = git(['rev-parse', 'HEAD']); report.dirty = git(['status', '--short']);
  await step('prerequisites: loopback sockets and explicit Chromium binary', async () => {
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
    assert.ok(process.env.CHROMIUM, 'Set CHROMIUM to a Chromium binary');
  });
  await step('launch isolated Studio and real Chromium', async () => {
    app = await startStudio({ directory, modelsOverride: models, provider: model.provider, models: [{ modelId: model.id, label: model.name }], variants: ['local'], whatsapp: false });
    notes = app.host.variants.get('local').notes;
    const seeded = await app.files.publication.publish({ operationId: 'fictional-seed', atomicity: 'all-or-nothing', changes: [
      { kind: 'create', target: notes, expected: { kind: 'absent' }, bytes: encode('# Fictional notes\n'), mediaType: 'text/markdown' },
    ] }, app.host.agentAccess);
    assert.equal(seeded.kind, 'committed');
    browser = await launch(app.url, { evidence });
    await openDocument();
    await browser.until('chat connected and document loaded', `${q('[data-testid=connection]')}?.dataset.state === 'connected' && !!${source}`);
  });
  await step('answer repeated-ID question cards, refuse unauthenticated answer, then retry', async () => {
    await browser.type(q('[data-testid=composer-input]'), 'Plan a fictional picnic.');
    await browser.click(q('[data-testid=composer-submit]'));
    await browser.click(q('[data-testid=question-card][data-state=pending] [data-option=park]'));
    await browser.until('second question pending', `!!${q('[data-testid=question-card][data-state=pending] [data-option=red]')}`);
    await browser.evaluate(`window.correctness = { fetch: window.fetch.bind(window), denyAnswer: true };
      window.fetch = async (input, init) => {
        const request = new Request(input, init), gate = window.correctness;
        if (new URL(request.url).searchParams.get('op') === 'answer' && gate.denyAnswer) {
          const headers = new Headers(request.headers); headers.delete('authorization');
          const response = await gate.fetch(new Request(request, { headers })); gate.deniedStatus = response.status; return response;
        }
        return gate.fetch(request);
      };`);
    await browser.click(q('[data-testid=question-card][data-state=pending] [data-option=red]'));
    await browser.until('denial shown on question', `!!${q('[data-testid=question-card][data-state=pending] [data-testid=question-refusal]')}`);
    assert.equal(await browser.evaluate('window.correctness.deniedStatus'), 401);
    assert.equal(transcripts.length, 2, 'denied answer does not resume the native task');
    await browser.evaluate('window.fetch = window.correctness.fetch');
    await browser.click(q('[data-testid=question-card][data-state=pending] [data-option=red]'));
    await browser.until('both questions answered and model complete', `${q('[data-testid=transcript]')}?.innerText.includes('Fictional plan complete.') && ${q('[data-testid=composer-submit]')}?.dataset.state === 'send'`);
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('[data-testid=question-answer]')].map(element => element.textContent)`), ['park', 'red']);
    assert.deepEqual(transcripts.at(-1).messages.filter(message => message.role === 'toolResult').map(message => JSON.parse(message.content[0].text).answer), ['park', 'red']);
  });
  await step('save through real HTTP and reconcile a lost acknowledgement without duplicate publication', async () => {
    await browser.evaluate(`window.correctness = { fetch: window.fetch.bind(window), lose: true, publications: [] };
      window.fetch = async (input, init) => {
        const request = new Request(input, init), gate = window.correctness;
        if (new URL(request.url).pathname !== '/api/resources') return gate.fetch(request);
        const body = await request.clone().json();
        if (body.kind !== 'publish') return gate.fetch(request);
        gate.publications.push(body.value.operationId);
        const response = await gate.fetch(request);
        if (gate.lose) { gate.lose = false; await response.arrayBuffer(); throw new TypeError('Fictional lost acknowledgement'); }
        return response;
      };`);
    await browser.type(source, 'Human edit survives.\n');
    const text = await browser.evaluate(`${source}.value`);
    await browser.click(q('[data-testid=viewer-save]'));
    await browser.until('save uncertain', `${status}?.textContent.includes('Save unconfirmed')`);
    assert.equal(await savedText(), text);
    const revision = (await saved()).ref.revision;
    await browser.click(button('Check save outcome'));
    await browser.until('save reconciled', `${status}?.textContent === undefined`);
    assert.equal((await saved()).ref.revision, revision);
    assert.equal(await browser.evaluate('window.correctness.publications.length'), 1);
  });
  await step('conflicting external edit does not overwrite either author', async () => {
    await browser.type(source, 'Local conflict draft.\n');
    const draft = await browser.evaluate(`${source}.value`), before = await saved();
    const external = await app.files.publication.publish({ operationId: 'fictional-external', atomicity: 'all-or-nothing', changes: [
      { kind: 'replace', target: before.ref, bytes: encode('# External fictional revision\n'), mediaType: 'text/markdown' },
    ] }, app.host.agentAccess);
    assert.equal(external.kind, 'committed');
    await browser.click(q('[data-testid=viewer-save]'));
    await browser.until('conflict shown', `document.body.innerText.includes('Your local text has been kept.')`);
    assert.equal(await browser.evaluate(`${source}.value`), draft);
    assert.equal(await savedText(), '# External fictional revision\n');
    await browser.click(button('Check saved version'));
    await browser.click(button('Discard local changes and reload'));
    await browser.until('explicit discard loads external content', `${source}?.value === '# External fictional revision\\n'`);
  });
  await step('reload reconnects to the same native transcript and saved document', async () => {
    await browser.reload();
    await openDocument();
    await browser.until('reconnected', `${q('[data-testid=connection]')}?.dataset.state === 'connected' && ${source}?.value === '# External fictional revision\\n'`);
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('[data-testid=question-answer]')].map(element => element.textContent)`), ['park', 'red']);
    assert.equal(transcripts.length, 3, 'reload does not run the model again');
    assert.deepEqual(browser.problems.filter(problem => problem.startsWith('exception:')), []);
    await browser.screenshot('correctness.png');
  });
  report.status = 'passed';
} catch (error) {
  report.status = !app ? 'blocked' : 'failed'; report.error = String(error); process.exitCode = 1;
} finally {
  report.browserProblems = browser?.problems ?? [];
  try { await browser?.close(); } catch (error) { report.status = 'failed'; report.cleanupError = String(error); process.exitCode = 1; }
  try { await app?.close(); } catch (error) { report.status = 'failed'; report.cleanupError = String(error); process.exitCode = 1; }
  rmSync(directory, { recursive: true, force: true });
  writeFileSync(join(evidence, 'journey.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  // Exit explicitly: a failure before the app started can leave handles open, and CI would wait out its whole timeout.
  process.exit(process.exitCode ?? 0);
}
