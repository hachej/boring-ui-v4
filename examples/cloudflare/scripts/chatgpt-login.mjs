// Sign the Cloudflare agent in with a ChatGPT subscription, once, and save the credential for the Worker secret CHATGPT_CREDENTIAL.
// This is a sign-in of its own: refreshing it in the Worker never signs out the Codex CLI or another app.
//   node examples/cloudflare/scripts/chatgpt-login.mjs            # prints a sign-in link; open it, then paste the final redirect URL
//                                                                 # (a localhost page that may fail to load); writes .cache/chatgpt-credential.json
//   npx wrangler secret put CHATGPT_CREDENTIAL --config examples/cloudflare/wrangler.jsonc < .cache/chatgpt-credential.json
//   node examples/cloudflare/scripts/chatgpt-login.mjs .cache/journey-chatgpt-credential.json   # a separate sign-in for local journeys
// Both the credential and its device id are created mode 0600 (see private-file.mjs).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createPrivateFile, writePrivateFile } from './private-file.mjs';

const out = process.argv[2] ?? '.cache/chatgpt-credential.json';
let saved;
const memory = {
  read: async () => saved, list: async () => (saved ? [{ providerId: 'openai', type: saved.type }] : []),
  modify: async (_id, fn) => { const next = await fn(saved); if (next !== undefined) saved = next; return saved; },
  delete: async () => { saved = undefined; },
};
const models = createModels({ credentials: memory });
models.setProvider(openaiProvider());
const terminal = createInterface({ input: process.stdin, output: process.stderr });
const interaction = {
  // Events carry the sign-in link and code; never the token.
  notify: event => console.error(JSON.stringify(event, (key, value) => (/token|access|refresh|secret/i.test(key) ? '[hidden]' : value), 2)),
  prompt: async prompt => {
    if (prompt.type === 'select' && Array.isArray(prompt.options)) {
      prompt.options.forEach((option, index) => console.error(`  ${index + 1}. ${option.label ?? option.value ?? option}`));
      const picked = Number(await terminal.question(`${prompt.message ?? 'Choose'} (number): `)) - 1;
      const option = prompt.options[picked] ?? prompt.options[0];
      return option.value ?? option;
    }
    // Unattended runs: wait for the redirect URL in a file instead of the terminal.
    if (process.env.LOGIN_ANSWER_FILE) {
      console.error(`${prompt.message ?? 'Input'} (waiting for ${process.env.LOGIN_ANSWER_FILE})`);
      for (;;) {
        if (existsSync(process.env.LOGIN_ANSWER_FILE)) { const answer = readFileSync(process.env.LOGIN_ANSWER_FILE, 'utf8').trim(); writeFileSync(process.env.LOGIN_ANSWER_FILE, ''); if (answer) return answer; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    return terminal.question(`${prompt.message ?? 'Input'}: `);
  },
};
// OpenAI identifies each installation by a stable UUID; keep one for this agent next to the credential.
const deviceFile = `${out}.device-id`;
mkdirSync(out.slice(0, out.lastIndexOf('/')) || '.', { recursive: true, mode: 0o700 });
// Both files are created 0600; neither is ever written with the default mode and chmod-ed afterwards.
try { createPrivateFile(deviceFile, randomUUID()); } catch (error) { if (error.code !== 'EEXIST') throw error; }
const deviceId = readFileSync(deviceFile, 'utf8').trim();
const credential = await models.login('openai', 'oauth', interaction, { getDeviceId: () => deviceId });
terminal.close();
writePrivateFile(out, JSON.stringify(credential));
console.error(`Signed in. Credential saved to ${out} (keep it private; it is git-ignored under .cache/).`);
