// Debug-only barriers for the restart proof (examples/cloudflare/whatsapp-journey.mjs). With ENABLE_DEBUG_ROUTES=1 a test may arm a
// one-shot hold at one of two boundaries, then reset the object while something waits there:
//   generation  the model stream of the request whose newest user message contains `match` waits before it starts (the answer is
//               not generated yet)
//   delivery    the WhatsApp gateway waits after the answer settled and before the Graph send, for the reply of requestId `match`
// Holds live in memory only: a restart forgets them, so the recovered object runs through both boundaries. Without the switch
// `debugHolds` returns undefined and the host wires nothing: the provider is used as is and the gateway gets no `beforeSend`.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export const HOLD_BOUNDARIES = Object.freeze(['generation', 'delivery']);

/** The text of the newest user message of a transcript. */
function newestUserText(transcript) {
  const message = [...(transcript?.messages ?? [])].reverse().find(item => item.role === 'user');
  if (!message) return '';
  return typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').join(' ');
}

/** The holds of this object instance, or undefined unless the operator enabled debug routes. */
export function debugHolds(env) {
  if (env?.ENABLE_DEBUG_ROUTES !== '1') return undefined;
  const armed = [];
  const waiting = [];

  /** Take the first armed hold of `boundary` that `matches`; resolves when it is released (or never, until the object stops). */
  const take = (boundary, matches) => {
    const index = armed.findIndex(hold => hold.boundary === boundary && matches(hold.match));
    if (index < 0) return undefined;
    const [hold] = armed.splice(index, 1);
    return new Promise(resolve => { waiting.push({ ...hold, since: Date.now(), release: resolve }); });
  };

  /** A provider whose streams wait at the generation boundary when a hold matches; every other member is the original. */
  const provider = original => {
    const held = call => (model, transcript, options) => {
      const wait = take('generation', match => newestUserText(transcript).includes(match));
      if (!wait) return call(model, transcript, options);
      const out = createAssistantMessageEventStream();
      void (async () => {
        await wait;
        const inner = call(model, transcript, options);
        for await (const event of inner) out.push(event);
        out.end(await inner.result());
      })().catch(() => out.end());
      return out;
    };
    const stream = held((...args) => original.stream(...args)), streamSimple = held((...args) => original.streamSimple(...args));
    return new Proxy(original, { get: (target, key) => {
      if (key === 'stream') return stream;
      if (key === 'streamSimple') return streamSimple;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };

  return {
    provider,
    /** The gateway's `beforeSend`: waits when a delivery hold names this reply's requestId. */
    beforeSend: async target => { const wait = take('delivery', match => match === target.requestId); if (wait) await wait; },
    arm: ({ boundary, match } = {}) => {
      if (!HOLD_BOUNDARIES.includes(boundary) || typeof match !== 'string' || !match) return false;
      armed.push({ boundary, match });
      return true;
    },
    /** Release every waiting hold with this match (all of them without one). */
    release: match => {
      for (let index = waiting.length - 1; index >= 0; index--) if (match === undefined || waiting[index].match === match) waiting.splice(index, 1)[0].release();
    },
    state: () => ({ armed: armed.map(({ boundary, match }) => ({ boundary, match })), waiting: waiting.map(({ boundary, match, since }) => ({ boundary, match, since })) }),
  };
}
