// The scripted model: the deterministic layer of the studio gates. A fictional keyless provider (the same fixture mechanism as the
// correctness journey, ./correctness-fixture.mjs) whose answers come from per-scenario scripts instead of a real model, so a scenario's
// UI and runtime expectations (tool cards, artifacts, queue, stop, ask_user, subagents, git, reload, share links ...) run the same way every time.
// A failure in this layer is a bug, never model variance. Server side only: it is chosen by the host process (STUDIO_MODEL=scripted, or
// `startStudio({ scripted: true })`), never by anything the browser sends. See "Two test layers" in ./README.md.
//
// A scenario (./scenarios/*.mjs) or UI journey (./journeys/*.mjs) has `script`: an object from a key to the model's turns.
//   key   a step number ("0" is the prompt of steps[0]) or any text that appears in the user message it answers
//   turns the model's turns for that message, in order. One turn is each time the runtime calls the model: a user message
//         starts turn 0, and every tool result starts the next turn. A turn is
//           'text'                                   a final answer
//           { text, reasoning, tools, delay, hold }  text and/or reasoning, then tool calls [{ name, args }]; `delay` waits first, `hold` keeps the turn open after the calls (ms)
//           { text: { chunks: [...], ms } }          streamed in chunks, `ms` apart (abortable: Stop works on it)
//           ctx => turn                              decided from what happened so far: ctx.user, ctx.input (the native message), ctx.results (name, args, text, json, isError, details), ctx.last, ctx.history,
//                                                    ctx.tools (the tool names this request offers), ctx.system (its system prompt)
// Which script answers: the conversation's first user message names the scenario (or journey); the last user message names the key. A
// message nothing answers is a failure: the model says so in the transcript and the journey fails at the end (`misses`).
//
// Two generic rules answer mechanical prompts without a script: "Reply with exactly: X" and "write the numbers from 1 to N in English words ... end
// with the exact line: X" (streamed, so Stop and queue scenarios have a long answer to act on).
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { createFixtureModels, assistantMessage } from './correctness-fixture.mjs';

const MODELS = [{ id: 'gpt-5-mini', name: 'GPT-5 mini' }, { id: 'gpt-5-nano', name: 'GPT-5 nano' }];
/** Pace of a streamed essay line: long enough for the journey to act while it works, short enough to keep the run fast. */
const LINE_MS = 130;

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
export function numberWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
}

/** The generic rules, as scripts over the same turn format. */
const GENERIC = [
  { match: /reply with exactly: ([A-Za-z0-9-]+)/i, turns: found => [found[1]] },
  { match: /write the numbers from 1 to (\d+) in english words.*?(?:end with the exact line: ([^.]+))?\.?\s*$/is, turns: found => {
    const lines = Array.from({ length: Number(found[1]) }, (_, at) => `${numberWords(at + 1)}\n`);
    if (found[2]) lines.push(found[2]);
    return [{ text: { chunks: lines, ms: LINE_MS } }];
  } },
];

/** Whether a prompt is answered by a generic rule (no `script` needed). The scenario loader uses this, so the two never disagree. */
export const answeredGenerically = prompt => GENERIC.some(rule => rule.match.test(prompt));

const textOf = message => typeof message.content === 'string' ? message.content
  : message.content.filter(part => part.type === 'text' && !part.text.startsWith('<file path="')).map(part => part.text).join('');
const sleep = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });

/** The scripts of every scenario and journey, as `{ name, entries: [{ match, turns }] }`. */
export async function loadSources() {
  // Loaded here, not at the top: another host (the ambient example) uses this model with scripts of its own.
  const { loadScenarios } = await import('./scenarios/index.mjs');
  const { JOURNEYS } = await import('./journeys/index.mjs');
  const sources = [];
  for (const scenario of await loadScenarios()) {
    if (!scenario.script) continue;
    sources.push({ name: scenario.id, entries: Object.entries(scenario.script).map(([key, turns]) => {
      const step = /^\d+$/.test(key) ? scenario.steps[Number(key)] : undefined;
      if (/^\d+$/.test(key) && !step?.prompt) throw new Error(`Scenario ${scenario.id}: script key ${key} is not a prompt step`);
      return { match: step ? step.prompt : key, turns };
    }) });
  }
  for (const [name, journey] of Object.entries(JOURNEYS)) if (journey.script) sources.push({ name: `journey ${name}`, entries: Object.entries(journey.script).map(([match, turns]) => ({ match, turns })) });
  return sources;
}

/** Earliest occurrence in the message wins (a background report quotes its task further down), then the longest key. */
function pick(entries, text) {
  const found = entries.map(entry => ({ entry, at: text.indexOf(entry.match) })).filter(item => item.at >= 0);
  found.sort((a, b) => a.at - b.at || b.entry.match.length - a.entry.match.length);
  return found[0]?.entry;
}

/** Messages no script answered, across restarts of the host in one run. */
export const misses = [];

/** `sources`: `[{ name, entries: [{ match, turns }] }]`; the studio's scenario and journey scripts when absent. */
export async function createScriptedModels({ sources = undefined } = {}) {
  sources ??= await loadSources();
  const model = ({ id, name }) => ({ id, name, provider: 'openai', api: 'scripted', baseUrl: 'https://fictional.invalid', input: ['text', 'image'], reasoning: false, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  let calls = 0;

  /**
   * The turns for the last user message of this transcript. The conversation's user messages name the script: the sources that answer the
   * most of them. Two sources can share a prefix (the same first prompt); that is fine while they answer the last message with the very same turns.
   */
  function turnsFor(messages) {
    const texts = messages.filter(message => message.role === 'user').map(textOf);
    const user = texts.at(-1) ?? '';
    const score = source => texts.filter(text => pick(source.entries, text)).length;
    const best = Math.max(0, ...sources.map(score));
    const named = best === 0 ? [] : sources.filter(source => score(source) === best);
    const entries = named.map(source => pick(source.entries, user)).filter(Boolean);
    if (entries.length > 0) {
      if (entries.some(entry => entry.turns !== entries[0].turns)) return { user, problem: `ambiguous script: ${named.map(source => source.name).join(' and ')} answer "${user.slice(0, 80)}" differently` };
      return { user, turns: entries[0].turns, source: named.find(source => pick(source.entries, user))?.name };
    }
    for (const rule of GENERIC) { const found = rule.match.exec(user); if (found) return { user, turns: rule.turns(found), source: 'generic' }; }
    return { user, problem: `no script answers "${user.slice(0, 120)}"${named[0] ? ` in ${named.map(source => source.name).join(' or ')}` : ''}` };
  }

  const stream = (chosen, context, options = {}) => {
    const events = createAssistantMessageEventStream();
    const message = assistantMessage(chosen, [], 'stop');
    const signal = options.signal;
    let finished = false;
    const abort = () => {
      if (finished) return;
      finished = true;
      message.stopReason = 'aborted'; message.errorMessage = 'Scripted provider cancelled';
      events.push({ type: 'error', reason: 'aborted', error: message }); events.end(message);
    };
    const run = async () => {
      events.push({ type: 'start', partial: message });
      const messages = context.messages;
      const lastUser = messages.map(item => item.role).lastIndexOf('user');
      const { user, turns, problem, source } = turnsFor(messages);
      const after = messages.slice(lastUser + 1);
      const resultOf = result => {
        const call = messages.flatMap(item => item.role === 'assistant' ? item.content : []).find(part => part.type === 'toolCall' && part.id === result.toolCallId);
        const text = result.content.map(part => part.text ?? '').join('');
        let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { name: result.toolName, args: call?.arguments, text, json, isError: result.isError, details: result.details };
      };
      const results = after.filter(item => item.role === 'toolResult').map(resultOf);
      // user: the typed text; input: the whole native message (attached files and images are parts of it); results: since that message; history: since the start.
      // tools and system: what this request offers and the system prompt it carries, as the model receives them.
      const ctx = { user, input: messages[lastUser]?.content, results, last: results.at(-1), history: messages.filter(item => item.role === 'toolResult').map(resultOf), messages,
        tools: getCurrentTools(messages).map(tool => tool.name), system: getCurrentSystemPrompt(messages) };
      const index = after.filter(item => item.role === 'assistant').length;
      let turn = problem ? undefined : turns[index];
      if (turn === undefined) {
        const why = problem ?? `the script of ${source} has no turn ${index} (it answered ${index} times already)`;
        misses.push(why); console.error(`scripted model: ${why}`);
        turn = `[scripted model: ${why}]`;
      }
      if (typeof turn === 'function') turn = turn(ctx);
      if (typeof turn === 'string') turn = { text: turn };
      if (turn.delay) await sleep(turn.delay, signal);
      if (signal?.aborted) return abort();
      if (turn.reasoning) {
        const at = message.content.push({ type: 'thinking', thinking: '' }) - 1;
        events.push({ type: 'thinking_start', contentIndex: at, partial: message });
        message.content[at].thinking = turn.reasoning;
        events.push({ type: 'thinking_delta', contentIndex: at, delta: turn.reasoning, partial: message });
        events.push({ type: 'thinking_end', contentIndex: at, content: turn.reasoning, partial: message });
      }
      if (turn.text) {
        const chunks = typeof turn.text === 'string' ? [turn.text] : turn.text.chunks, ms = typeof turn.text === 'string' ? 0 : turn.text.ms ?? 0;
        const at = message.content.push({ type: 'text', text: '' }) - 1;
        events.push({ type: 'text_start', contentIndex: at, partial: message });
        for (const chunk of chunks) {
          if (signal?.aborted) return abort();
          message.content[at].text += chunk;
          events.push({ type: 'text_delta', contentIndex: at, delta: chunk, partial: message });
          if (ms) await sleep(ms, signal);
        }
        if (signal?.aborted) return abort();
        events.push({ type: 'text_end', contentIndex: at, content: message.content[at].text, partial: message });
      }
      for (const tool of turn.tools ?? []) {
        const args = typeof tool.args === 'function' ? tool.args(ctx) : tool.args ?? {};
        const call = { type: 'toolCall', id: `call_${++calls}`, name: tool.name, arguments: args };
        const at = message.content.push(call) - 1;
        events.push({ type: 'toolcall_start', contentIndex: at, partial: message });
        events.push({ type: 'toolcall_end', contentIndex: at, toolCall: call, partial: message });
      }
      if (turn.hold) await sleep(turn.hold, signal); // the call is on screen, running, before the turn ends
      if (signal?.aborted) return abort();
      message.stopReason = turn.tools?.length ? 'toolUse' : 'stop';
      finished = true;
      events.push({ type: 'done', reason: message.stopReason, message }); events.end(message);
    };
    signal?.addEventListener('abort', abort, { once: true });
    run().catch(error => { misses.push(`the scripted model failed: ${error?.stack ?? error}`); if (!finished) { finished = true; message.stopReason = 'error'; message.errorMessage = String(error); events.push({ type: 'error', reason: 'error', error: message }); events.end(message); } });
    return events;
  };
  return { models: createFixtureModels(MODELS.map(model), stream, 'openai'), misses };
}

