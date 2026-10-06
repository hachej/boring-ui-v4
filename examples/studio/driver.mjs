// Minimal headless-Chromium driver over the DevTools protocol (no extra dependency).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A name the browser resolves to the local server but treats as an insecure context (plain HTTP, not localhost): no crypto.randomUUID, crypto.subtle, navigator.clipboard or navigator.share. */
export const insecureUrl = url => url.replace('127.0.0.1', 'insecure.test');

/** `args`: extra Chromium flags (for example `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` for a fake microphone). */
export async function launch(url, { chromium = process.env.CHROMIUM, evidence = '.', args = [] } = {}) {
  if (!chromium) throw new Error('Set CHROMIUM to a Chromium or chrome-headless-shell binary');
  const profile = mkdtempSync(join(tmpdir(), 'boring-studio-profile-'));
  const child = spawn(chromium, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1500,950', '--host-resolver-rules=MAP insecure.test 127.0.0.1', ...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let text = '';
    child.stderr.on('data', chunk => { text += chunk; const found = /DevTools listening on (ws:\/\/\S+)/.exec(text); if (found) resolve(found[1]); });
    child.once('exit', code => reject(new Error(`Chromium exited ${code}\n${text}`)));
    setTimeout(() => reject(new Error(`Chromium did not start\n${text}`)), 20000);
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0, sessionId;
  const waiting = new Map(), problems = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id); waiting.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') problems.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`console.error: ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`);
  };
  const sendTo = (session, method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next; waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
  const send = (method, params = {}) => sendTo(sessionId, method, params);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url });
  // evaluate / until over one page session (the first page, or another tab of the same profile).
  const inspect = sendFn => {
    const evaluate = async expression => {
      const { result, exceptionDetails } = await sendFn('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    };
    const until = async (label, expression, timeout = 20000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = await evaluate(expression).catch(() => undefined);
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${(await evaluate('document.body.innerText').catch(() => '')).slice(0, 3000)}\n${problems.join('\n')}`);
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    };
    return { evaluate, until };
  };
  const { evaluate, until } = inspect(send);
  /** Another tab of the same browser profile (same origin storage). Close it with `close()`. */
  const openTab = async (url, { hidden = false } = {}) => {
    const created = await sendTo(undefined, 'Target.createTarget', { url: 'about:blank' });
    const { sessionId: tabSession } = await sendTo(undefined, 'Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const tabSend = (method, params = {}) => sendTo(tabSession, method, params);
    await tabSend('Runtime.enable'); await tabSend('Page.enable');
    // Headless Chromium has no window stack, so every tab reports visible. `hidden` makes the tab report what a background tab does
    // (document.hidden and visibilityState, with visibilitychange) from before its first script; `setVisible` flips it later.
    await tabSend('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      let state = ${hidden ? "'hidden'" : "'visible'"};
      Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => state });
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => state === 'hidden' });
      window.__setVisibility = next => { state = next; document.dispatchEvent(new Event('visibilitychange')); };
    })()` });
    await tabSend('Page.navigate', { url });
    return { ...inspect(tabSend), send: tabSend, setVisible: visible => inspect(tabSend).evaluate(`window.__setVisibility(${visible ? "'visible'" : "'hidden'"})`), close: () => sendTo(undefined, 'Target.closeTarget', { targetId: created.targetId }) };
  };
  // Real pointer and keyboard input through the browser, not synthetic DOM events.
  const click = async selector => {
    const box = await until(`clickable ${selector}`, `(() => { const e = ${selector}; if (!e || e.disabled) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };
  const type = async (selector, text) => { await click(selector); await evaluate(`(() => { const e = ${selector}; e.focus(); e.selectionStart = e.selectionEnd = e.value.length; })()`); await send('Input.insertText', { text }); };
  // Keyboard input as the browser would deliver it. `shift` makes Enter a newline.
  const KEYS = { Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 }, Backspace: { code: 'Backspace', keyCode: 8, commands: ['deleteBackward'] },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, Tab: { code: 'Tab', keyCode: 9 } };
  const press = async (key, { shift = false, alt = false } = {}) => {
    const info = KEYS[key] ?? { code: key, keyCode: key.toUpperCase().charCodeAt(0), ...(key.length === 1 ? { text: key } : {}) };
    const base = { key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers: (alt ? 1 : 0) | (shift ? 8 : 0), ...(info.commands ? { commands: info.commands } : {}) };
    await send('Input.dispatchKeyEvent', { type: info.text ? 'keyDown' : 'rawKeyDown', ...base, ...(info.text ? { text: info.text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  // A real pointer drag from the centre of `selector` to the given page x (same y), in steps. `release: false` stops with the button down; `release()` lets go.
  const drag = async (selector, toX, { release = true } = {}) => {
    const box = await until(`draggable ${selector}`, `(() => { const e = ${selector}; if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    const mouse = (type, x, buttons) => send('Input.dispatchMouseEvent', { type, x, y: box.y, button: 'left', buttons, clickCount: 1 });
    await mouse('mousePressed', box.x, 1);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', box.x + (toX - box.x) * i / 8, 1);
    const finish = () => mouse('mouseReleased', toX, 0);
    if (release) await finish();
    return { release: finish, moveTo: x => mouse('mouseMoved', x, 1) };
  };
  const hover = async selector => {
    const box = await until(`hoverable ${selector}`, `(() => { const e = ${selector}; if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  };
  // Put local files into an <input type=file> the way the browser's file dialog does (DOM.setFileInputFiles), firing its change event.
  const attachFiles = async (selector, files) => {
    await until(`file input ${selector}`, `!!(${selector})`);
    const { result } = await send('Runtime.evaluate', { expression: selector });
    await send('DOM.setFileInputFiles', { files, objectId: result.objectId });
  };
  // A tap as a finger delivers it: touchStart and touchEnd at the centre of the element (needs touch emulation, see `emulate`).
  const tap = async selector => {
    const box = await until(`tappable ${selector}`, `(() => { const e = ${selector}; if (!e || e.disabled) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  // Device emulation through the DevTools protocol. `phone` is 390x844 at 3x with touch, `tablet` 768x1024 with touch, `desktop`
  // restores the default viewport and mouse so later journeys are unaffected.
  const DEVICES = { phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, tablet: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true } };
  const emulate = async device => {
    if (device === 'desktop') {
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await send('Emulation.clearDeviceMetricsOverride');
    } else {
      if (!DEVICES[device]) throw new Error(`Unknown device ${device}`);
      await send('Emulation.setDeviceMetricsOverride', { ...DEVICES[device], screenWidth: DEVICES[device].width, screenHeight: DEVICES[device].height });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
  };
  // Evaluates in an <iframe> whose document the page cannot reach (a sandboxed preview with an opaque origin): `frame` is an expression for the
  // iframe element. The browser's own protocol reaches into the frame, in this process or, when the browser put it in its own, through that target.
  const frameEvaluate = async (frame, expression) => {
    const { result } = await send('Runtime.evaluate', { expression: frame });
    if (!result.objectId) throw new Error('No such frame element');
    const { node } = await send('DOM.describeNode', { objectId: result.objectId });
    try {
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: node.frameId, worldName: 'journey' });
      const inside = await send('Runtime.evaluate', { contextId: executionContextId, expression, returnByValue: true, awaitPromise: true });
      if (inside.exceptionDetails) throw new Error(inside.exceptionDetails.exception?.description ?? inside.exceptionDetails.text);
      return inside.result.value;
    } catch (error) {
      const { targetInfos } = await send('Target.getTargets');
      const target = targetInfos.find(info => info.type === 'iframe' && info.targetId === node.frameId);
      if (!target) throw error;
      const { sessionId: attached } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      try {
        const inside = await sendTo(attached, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (inside.exceptionDetails) throw new Error(inside.exceptionDetails.exception?.description ?? inside.exceptionDetails.text);
        return inside.result.value;
      } finally { await send('Target.detachFromTarget', { sessionId: attached }).catch(() => {}); }
    }
  };
  const wheel = (x, y, deltaY) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  return {
    evaluate, frameEvaluate, until, openTab, click, tap, emulate, type, press, drag, hover, attachFiles, wheel, send, problems,
    screenshot: async name => writeFileSync(join(evidence, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64')),
    reload: () => send('Page.reload'),
    close: async () => { socket.close(); child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chromium may still be flushing its throwaway profile */ } },
  };
}
