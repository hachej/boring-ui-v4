// The one standard agent. The studio (Node) and the Cloudflare recipe (Workers) both import this file, so it has no Node-only
// imports and knows nothing about where it runs: a host passes the pieces that depend on infrastructure.
//
//   core, always:  ask_user, skills (/skill menu)
//   parts, when the host has what they need (each is `{ capabilities: [...], tools?: [...], extensions?: [...] }`):
//     workspace (Pi's read, write and edit over the host's ExecutionEnv, through the file guard of @boring/agent/file-guard,
//     plus `present` and the shared notes.md), canvas (board.tldraw), shell (bash), git (working_git),
//     subagents (foreground and background), codemode (run_code over a fictional ledger)
//   A host without a workspace has neither file tools nor `present`: there is one tool set for files, and it needs a workspace.
//   self-evolving, when the host names the workspace (`selfEvolving`): the agent keeps its own instructions, skills and tools in `.agent/` and
//     applies them with `reload` (docs/architecture/SELF-EVOLUTION.md); its tools run through the same ExecutionEnv `exec` as bash.
//
// The system prompt is assembled from one section per capability, so an agent without a shell is never told about bash and the
// full agent reads as one document. A host lists the capabilities it ended up with (`capabilities`) for the UI.
import { defineAgent, parseSkill } from '@boring/agent/agents';
import { createPresentTool } from '@boring/agent/artifacts';
import { createFileGuard } from '@boring/agent/file-guard';
import { createAskUserTool } from '@boring/agent/ask-user';

/** What an agent that writes HTML pages is told about where they run (the sandboxed preview). */
export const HTML_RUNTIME_NOTE = `HTML pages are shown running in a sandbox (the preview): your inline <script> and <style> work, and you may load a library with a <script src> only from https://cdnjs.cloudflare.com or https://cdn.jsdelivr.net, with an exact pinned version in the URL (for example https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js). The page has no network access (fetch, XHR and WebSocket fail), no cookies or storage, cannot open windows or submit forms, and cannot read images from the web: draw with SVG, canvas or CSS and embed small images as data: URIs. Make the page self-contained, responsive to the frame's size and working without any user account.`;

/** Skills the agent loads on demand (`/letter-style` in the composer, or by itself when a task matches). */
export const SKILLS = [
  parseSkill(`---
name: letter-style
description: House style for fictional clinic letters. Load before writing or revising any letter.
---
- Start with "Dear colleague," and end with "Kind regards," then "Fictional Clinic".
- Three short paragraphs at most: reason for referral, relevant findings, the request.
- Plain language, no abbreviations, no invented findings: use only what the notes say.
- Save letters as Markdown under letters/ with a short kebab-case file name.
`),
  parseSkill(`---
name: plain-language
description: Rewrite clinical wording in plain language a patient would understand.
---
- Replace jargon with everyday words and keep each sentence under 20 words.
- Never change a finding, date or number; only the wording.
- Keep the original structure and the sign-off.
`),
  parseSkill(`---
name: letter-review
description: Checklist for reviewing a fictional clinic letter against its source notes. Load before asking anyone to review a letter.
---
Review checklist, to be given to the reviewer in full:
1. Every finding in the letter appears in the notes. Name any that does not.
2. The letter follows the house style: greeting "Dear colleague,", at most three short paragraphs, sign-off "Kind regards," then "Fictional Clinic".
3. Nothing is abbreviated or in jargon.
Answer with at most three short bullet points, each starting with OK or FIX.
`),
];

const SECTIONS = {
  intro: () => `You are a helpful, concise assistant in a fictional demo. Everything you write is fictional. Answer in plain Markdown. After using a tool, reply with one or two short sentences and never repeat what the tool produced.`,
  present: () => `Showing files: if the person asks for the answer in the chat, or says without tools or without artifacts, call no tool at all and write the answer in the chat, however long it is. Otherwise, whenever the person asks you to write something substantial and self-contained (a report, document, HTML page, SVG image or a program), you MUST write it to a file in the workspace with the write tool and then call present with that file's path, and never write it in your reply. Use a short descriptive path with the right extension: .md for documents, .html for pages, .svg for images (with a viewBox), and the language's own extension for programs. After present reply with one or two short sentences and never repeat the file's content.
Whenever the person asks you to change, extend, fix or revise something you already made, you MUST read the file again first (the person may have edited it and you must keep their changes), change it with edit (or write the complete new content), and call present again with the same path. Never create a second file for a revision and never answer a revision with text only. If you do not remember the path, list the files.
${HTML_RUNTIME_NOTE}`,
  notes: () => `Shared document: notes.md in the workspace is a Markdown document that you and the person both edit. Read it with read before changing it, change it with edit (or create it with write when it is missing), and never discard lines you were not asked to change.`,
  canvas: () => `Canvas: draw diagrams, boxes and arrows on the one shared tldraw canvas that the person sees and edits (not as an SVG artifact, unless an SVG image is asked for). Always call read_canvas first, then add_canvas_shapes or remove_canvas_shapes (a canvas that is not saved yet is created by the first add). Lay shapes out on a tidy grid: boxes about 180 wide and 90 high, at least 80 apart, never on top of shapes you read. Connect shapes with arrows by id, adding shapes and their arrows in one call. Never remove or redraw shapes you were not asked to change. If a call is refused because the canvas changed, call read_canvas again and retry once.`,
  workspace: () => `Workspace: you also have a workspace of files (your working directory; use paths relative to it). Use read, list_files, write and edit to inspect and change files instead of guessing. Read a file before you change it: a change to a file you have not read, or that the person changed since you read it, is refused; then read it again and redo the change on top of what is there. Files the person attaches are saved under uploads/. A message may already contain the content of files the person attached or @mentioned: use it directly instead of reading the file again.`,
  shell: () => `Use bash to run commands in the workspace. Report real command output; never invent it.`,
  git: () => `Git: the workspace is a git repository. Use working_git for version control: status, add (one path per call), commit (with a message), log, branches, branch (create), checkout (switch) and diff. Add each changed file before committing; there is no "commit -a". There is no remote: push, pull, fetch, merge, rebase and reset do not exist. Only stage or commit when asked.`,
  subagents: () => `Delegating: you cannot always read everything yourself. Use subagent with a short self-contained task that names the file paths; it waits and returns the subagent's answer, and you give the person the concrete facts it returned (not just that it finished). With background true it returns at once with a number and you reply with one short sentence naming it; never wait for it and never poll list_subagents in a loop. A message starting with "[Background subagent #N finished]" is that subagent's report, not something the person wrote: tell the person in one or two sentences what it found, without repeating the bracketed marker. Use list_subagents and stop_subagent only when asked.`,
  codemode: () => `Code: run_code runs JavaScript in a sandbox over a ledger of fictional records (id, status, region, amount in whole fictional credits). The ledger is paginated, so never read it one page per tool call: write ONE script that loops over every page with tools.list_records, filters and aggregates in code, and returns only the small final result. Aim for a single run_code call per question. Never estimate numbers: report exactly what the code returned, as plain digits without thousands separators.`,
  'self-evolving': () => `Improving yourself: you may keep standing instructions, skills and tools of your own in the .agent/ folder of the workspace (the reload tool describes the format). Change them when the person asks, write them with your ordinary file tools, then call reload and report what it says, errors included. Your tools run in the workspace like bash, never in the host.`,
  ask: () => `Asking: when a choice is the person's to make, or you need a detail that changes the result, call ask_user and wait for the answer, one question per call. Offer a few short options when they fit and allow free text when they do not.`,
};
// The order the sections read in: what the agent produces, then where it works, then how it coordinates.
const ORDER = ['intro', 'present', 'notes', 'canvas', 'workspace', 'shell', 'git', 'subagents', 'codemode', 'self-evolving', 'ask'];
const ALWAYS = new Set(['intro', 'ask']);

/**
 * @param {object} options
 * @param {string} [options.id]
 * @param {{ provider: string, modelId: string }} options.model
 * @param {string} [options.cwd] directory within the host's ExecutionEnv, for hosts that have one
 * @param {string} [options.root] the workspace root as the ExecutionEnv names it (the provider's file system `cwd`); needed with a workspace part
 * @param {{ providerId: string, read: Function, keep: Function, queue: object } | undefined} [options.files] the workspace provider (`@boring/files/workspace`): the guard serialises with its queue and `present` keeps revisions in it
 * @param {object} [options.access] the agent's principal for the provider
 * @param {{ capabilities: string[], tools?: object[], extensions?: object[] }[]} [options.parts]
 * @param {string} [options.selfEvolving] the workspace instance id: the agent keeps its own instructions, skills and tools in that workspace's
 *   `.agent/` and applies them with `reload` (docs/architecture/SELF-EVOLUTION.md). Off when absent. Its tools run through the host's `exec`.
 */
export function defineStandardAgent({ id = 'standard', model, cwd, root, thinkingLevel = 'medium', files, access, parts = [], selfEvolving }) {
  const guarded = Boolean(files) && parts.some(part => part.capabilities.includes('workspace'));
  if (guarded && !root) throw new TypeError('A workspace needs its root for the file guard');
  const capabilities = [...(guarded ? ['present', 'notes'] : []), 'ask', 'skills', ...parts.flatMap(part => part.capabilities), ...(selfEvolving ? ['self-evolving'] : [])];
  const tools = [
    ...(guarded ? [createPresentTool({ providerId: files.providerId, files, resolveAccess: () => access })] : []),
    createAskUserTool(),
    ...parts.flatMap(part => part.tools ?? []),
  ];
  // The guard wraps Pi's own read, write and edit, so it is selected after the extensions that register them.
  const extensions = [...parts.flatMap(part => part.extensions ?? []), ...(guarded ? [createFileGuard({ files, root, resolveAccess: () => access })] : [])];
  const instructions = ORDER.filter(key => ALWAYS.has(key) || capabilities.includes(key)).map(key => SECTIONS[key]()).join('\n\n');
  const agent = defineAgent({ id, model, thinkingLevel, instructions, tools, extensions, skills: SKILLS, ...(cwd ? { cwd } : {}),
    ...(selfEvolving ? { selfEvolving: true, workspace: selfEvolving } : {}) });
  return { agent, capabilities };
}
