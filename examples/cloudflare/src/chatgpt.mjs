// The OpenAI model, with either an API key (Worker secret OPENAI_API_KEY, preferred when set) or a ChatGPT subscription
// ("Sign in with ChatGPT", pi-ai's `openai` provider with its OAuth credential).
// The credential is kept in this object's storage, which pi-ai's `Models` reads and rewrites when it refreshes the token, one write
// at a time. The Worker secret CHATGPT_CREDENTIAL only seeds it the first time: make it with
// `node examples/cloudflare/scripts/chatgpt-login.mjs`, a sign-in of its own, so refreshing here never signs out another app.
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';

export const CHATGPT_PROVIDER_ID = 'openai';
export const CHATGPT_DEFAULT_MODEL = 'gpt-5.5';
const KEY = 'pi-ai-credentials';

// pi-ai loads OAuth flows through a variable import a bundler cannot follow; register them statically so refresh works in a Worker.
registerBunOAuthFlows();

/** A pi-ai CredentialStore over Durable Object storage. Writes are serialized; the object is the only process using it. */
export function durableObjectCredentialStore(storage, seed) {
  let queue = Promise.resolve();
  const all = async () => {
    const stored = await storage.get(KEY);
    if (stored) return stored;
    return seed ? { [CHATGPT_PROVIDER_ID]: seed } : {};
  };
  return {
    read: async providerId => (await all())[providerId],
    list: async () => Object.entries(await all()).map(([providerId, credential]) => ({ providerId, type: credential.type })),
    modify: (providerId, fn) => {
      const run = queue.then(async () => {
        const current = await all();
        const next = await fn(current[providerId]);
        if (next === undefined) return current[providerId];
        await storage.put(KEY, { ...current, [providerId]: next });
        return next;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    delete: providerId => {
      const run = queue.then(async () => { const current = await all(); delete current[providerId]; await storage.put(KEY, current); });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** The seed credential from the Worker secrets, or undefined: an API key first, else the ChatGPT sign-in. */
export function chatGPTSeed(env) {
  if (env.OPENAI_API_KEY) return { type: 'api_key', key: env.OPENAI_API_KEY };
  if (!env.CHATGPT_CREDENTIAL) return undefined;
  const value = JSON.parse(env.CHATGPT_CREDENTIAL);
  if (value?.type !== 'oauth' || typeof value.access !== 'string' || typeof value.refresh !== 'string') throw new Error('CHATGPT_CREDENTIAL is not a pi-ai OAuth credential');
  return value;
}

/** pi-ai Models with the OpenAI provider. An API key is used as given; a ChatGPT sign-in is kept in storage and refreshed there. */
export function chatGPTModels(storage, env, wrapProvider = provider => provider) {
  const seed = chatGPTSeed(env);
  const credentials = seed?.type === 'api_key'
    ? { read: async () => seed, list: async () => [{ providerId: CHATGPT_PROVIDER_ID, type: 'api_key' }], modify: async () => seed, delete: async () => {} }
    : durableObjectCredentialStore(storage, seed);
  const models = createModels({ credentials });
  models.setProvider(wrapProvider(openaiProvider()));
  return models;
}
