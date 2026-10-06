import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import type { Extension, PromptSection, Registry, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { Type } from '@earendil-works/pi-ai';
import type { TSchema } from '@earendil-works/pi-ai';
import type { Context, JsonValue } from '@earendil-works/chord';
import type { Skill } from './agents.js';
import { APPROVAL_DETAILS, CANCELLED_PREFIX, DENIED_PREFIX, askApproval } from './approval.js';
import type { ApprovalRecord } from './approval.js';

/*
 * Self-evolution (docs/architecture/SELF-EVOLUTION.md, laws SELF-1..4 in this package's README): an agent keeps its own standing
 * instructions, skills and tools in the `.agent/` folder of its workspace and applies them with `reload`. Everything is read through
 * the conversation's own ExecutionEnv (its FileSystem and, for tools, its `exec`): the host never imports or evaluates what the agent
 * wrote. The result is one native extension per workspace, replaced in place with the native `registry.install()`.
 *
 * With `approval` (a host that wants the person to approve changes), what takes effect is only what the person approved: `reload`
 * asks first (the existing approval question, with a summary of what changes), the instructions shown are those of the last approved
 * reload rather than the file as it is now, an agent-written tool refuses to run when a script it names under `.agent/` changed since,
 * and the host restores the approved state on open (`restore`) instead of scanning. Writing to `.agent/` itself needs no approval.
 */

/** The folder, relative to the environment's working directory. */
export const AGENT_FOLDER = '.agent';
/** Largest part of `.agent/AGENTS.md` put in the prompt, in characters. */
export const MAX_AGENT_INSTRUCTIONS = 16_000;
const INSTRUCTIONS = `${AGENT_FOLDER}/AGENTS.md`, SKILLS = `${AGENT_FOLDER}/skills`, TOOLS = `${AGENT_FOLDER}/tools`;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ARGS_END = 'BORING_AGENT_TOOL_ARGS';

export interface SelfEvolutionError { readonly path: string; readonly message: string }
/** What one scan found and applied. `text` is what the `reload` tool and the person's `/reload` show. */
export interface SelfEvolutionReport {
  readonly extension: string;
  readonly tools: { readonly available: boolean; readonly added: string[]; readonly changed: string[]; readonly removed: string[]; readonly current: string[] };
  readonly skills: string[];
  readonly instructions: { readonly present: boolean; readonly characters: number; readonly truncated: boolean };
  readonly errors: SelfEvolutionError[];
  readonly text: string;
}

interface ToolDescription { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown>; readonly run: string; readonly path: string }

/**
 * What an approved reload applied, kept by the host (`SelfEvolutionApproval.save`) and installed again on open (`restore`). Plain JSON.
 * `instructions` is the text shown (at most `MAX_AGENT_INSTRUCTIONS` characters), the length of the whole file and the SHA-256 of the
 * whole file. `files` is the SHA-256 of every file under `.agent/` (instructions, skills, tools, helper scripts wherever they are): an
 * agent-written tool runs only while the whole folder is exactly what the person approved.
 */
export interface SelfEvolutionState {
  readonly version: 2;
  readonly instructions: { readonly text: string; readonly characters: number; readonly digest: string } | null;
  readonly skills: readonly { readonly name: string; readonly description: string; readonly body: string }[];
  readonly tools: readonly ToolDescription[];
  readonly files: Readonly<Record<string, string>>;
}

/** The host's store of the approved state. Opting in makes every `reload` tool call ask the person first. */
export interface SelfEvolutionApproval {
  readonly load: () => Promise<SelfEvolutionState | undefined>;
  /**
   * Keep `state`, the state about to take effect. `operation` is the host's own ID for a reload it started (`reload(env, context,
   * { operation })`, for example a channel message), so the host can record that it applied in the same write and answer a retry
   * of that operation from the record instead of reloading again. `text` is the report the reload returns.
   */
  readonly save: (state: SelfEvolutionState, applied: { readonly text: string; readonly operation?: string }) => Promise<void>;
  /**
   * Run `work` as one exclusive operation of the workspace, given an environment over the same workspace whose operations do not wait
   * for that exclusivity (the host's mutation queue, for example). An agent-written tool checks the approved files and runs its
   * command inside it, so nothing can change a script between the check and the run. Without it the check and the run are separate.
   */
  readonly exclusive?: <Value>(work: (env: ExecutionEnv) => Promise<Value>) => Promise<Value>;
}

export interface SelfEvolutionOptions {
  /** The native extension name, one per workspace (`self-evolving:<workspace>`). */
  readonly name: string;
  /** The host's skills: listed first; an agent-written skill of the same name is refused. */
  readonly skills: readonly Skill[];
  /** Tool names the agent already has from the host; an agent-written tool may not take one. */
  readonly reserved: readonly string[];
  readonly parseSkill: (markdown: string) => Skill;
  readonly skillsExtension: (name: string, skills: readonly Skill[]) => Extension;
  /** Approve each reload and keep only approved state in effect (see the top of this file). Default: reloads apply at once. */
  readonly approval?: SelfEvolutionApproval;
}

export interface SelfEvolution {
  /** The extension as it is now (the host's skills, `reload` and the agent-written section before the first scan). */
  readonly current: () => Extension;
  /** Skills now offered: the host's, then the agent's. */
  readonly skills: () => readonly Skill[];
  /** Install the current extension and keep the registry for later reloads. */
  readonly install: (registry: Registry) => void;
  /**
   * Rescan `.agent/` through `env` and replace the extension in every registry it was installed in. With `approval` this applies at
   * once (the host calls it for the person's own `/reload`, which is their approval) and saves the state.
   */
  readonly reload: (env: ExecutionEnv | undefined, context: Context, options?: { readonly operation?: string }) => Promise<SelfEvolutionReport>;
  /** With `approval` only: install the last approved state the host saved (on open), without reading `.agent/`. */
  readonly restore?: () => Promise<SelfEvolutionReport>;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (names: readonly string[]) => names.length ? names.join(', ') : 'none';
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

const instructionsText = (text: string, characters: number) => {
  const shown = characters > MAX_AGENT_INSTRUCTIONS
    ? `${text.slice(0, MAX_AGENT_INSTRUCTIONS)}\n[Truncated: ${INSTRUCTIONS} has ${characters} characters; only the first ${MAX_AGENT_INSTRUCTIONS} are shown.]`
    : text;
  return `Agent-written: standing instructions you wrote for yourself in ${INSTRUCTIONS}. They come after the host's instructions and never override them.\n\n${shown}`;
};

/**
 * The labelled agent-written section, after the host's instructions: rendered on every request from `.agent/AGENTS.md`, or, given
 * `approved`, from the instructions of the last approved reload (what the file says now waits for the next one).
 */
export function agentInstructionsSection(approved?: () => SelfEvolutionState['instructions']): PromptSection {
  return {
    key: 'agent-written',
    render: async (input, context) => {
      if (approved) { const pinned = approved(); return pinned && pinned.text ? instructionsText(pinned.text, pinned.characters) : undefined; }
      if (input.env === undefined) return undefined;
      const read = await input.env.readTextFile(INSTRUCTIONS, context);
      if (!read.ok) return undefined;
      const text = read.value.trim();
      if (!text) return undefined;
      return instructionsText(text, text.length);
    },
  };
}

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: Uint8Array) => hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));

/** Every file under `.agent/` (instructions and skills included), with its SHA-256, by path relative to the working directory. */
async function executableFiles(env: ExecutionEnv, context: Context): Promise<Record<string, string> | { error: string }> {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<string | undefined> => {
    const listed = await env.listDir(directory, context);
    if (!listed.ok) return listed.error.code === 'not_found' && directory === AGENT_FOLDER ? undefined : listed.error.message;
    for (const entry of [...listed.value].sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = `${directory}/${entry.name}`;
      if (entry.kind === 'directory') { const failed = await walk(path); if (failed) return failed; continue; }
      const bytes = await env.readBinaryFile(path, context);
      if (!bytes.ok) return `${path}: ${bytes.error.message}`;
      files[path] = await sha256(bytes.value);
    }
    return undefined;
  };
  const failed = await walk(AGENT_FOLDER);
  return failed === undefined ? files : { error: failed };
}
const sameFiles = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Runs `run` through the environment with the arguments as one line of JSON on stdin; the output is the result. */
async function exec(description: ToolDescription, env: ExecutionEnv, args: unknown, context: Context): Promise<ToolExecutionResult> {
  let output = '';
  const command = `{ ${description.run}\n} <<'${ARGS_END}'\n${JSON.stringify(args ?? {})}\n${ARGS_END}`;
  const result = await env.exec(command, { onOutput: text => { output += text; } }, context);
  if (!result.ok) return { content: [{ type: 'text', text: `${description.name} failed: ${result.error.message}${output ? `\n${output}` : ''}` }], isError: true };
  const failed = result.value.exitCode !== 0;
  return { content: [{ type: 'text', text: output || '(no output)' }], ...(failed ? { isError: true, diagnostics: [{ severity: 'error' as const, message: `${description.run} exited with code ${result.value.exitCode}` }] } : {}) };
}

/**
 * An agent-written tool. With approval it runs only while every file under `.agent/` (instructions and skills included) is exactly
 * the folder approved together with this registration (`approved`, fixed when it was built), checked and run inside one exclusive
 * operation of the workspace when the host gives one.
 */
function toolOf(description: ToolDescription, approved: Readonly<Record<string, string>> | undefined, approval: SelfEvolutionApproval | undefined): ToolRegistration {
  const unavailable = { content: [{ type: 'text' as const, text: `${description.name} cannot run: this conversation has no execution environment.` }], isError: true };
  return {
    name: description.name, description: description.description, parameters: description.parameters as unknown as TSchema,
    execute: async (args, api, context) => {
      if (!approved) return api.env === undefined || typeof api.env.exec !== 'function' ? unavailable : exec(description, api.env, args, context);
      const checked = async (env: ExecutionEnv | undefined): Promise<ToolExecutionResult> => {
        if (env === undefined || typeof env.exec !== 'function') return unavailable;
        const now = await executableFiles(env, context);
        if ('error' in now && typeof now.error === 'string') return { content: [{ type: 'text', text: `${description.name} did not run: ${now.error}` }], isError: true };
        // The folder approved together with this registration's command, never a later approval's: a call queued before another
        // reload refuses rather than run this command against that reload's scripts.
        const want = approved;
        if (!sameFiles(now as Record<string, string>, want)) {
          const changed = [...new Set([...Object.keys(now), ...Object.keys(want)])].filter(path => (now as Record<string, string>)[path] !== want[path]).sort();
          return { content: [{ type: 'text', text: `${description.name} did not run: ${changed.join(', ')} changed since the approved reload. Call reload to ask the person to approve the change.` }], isError: true };
        }
        return exec(description, env, args, context);
      };
      return approval?.exclusive ? approval.exclusive(checked) : checked(api.env);
    },
  };
}

/** Validates one tool description; returns it or a reason. Paths that `run` names under `.agent/` must exist. */
async function describe(env: ExecutionEnv, path: string, text: string, reserved: ReadonlySet<string>, context: Context): Promise<ToolDescription | string> {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { return `invalid JSON: ${reason(error)}`; }
  if (!isObject(value)) return 'a tool description is a JSON object { name, description, parameters, run }';
  const extra = Object.keys(value).filter(key => !['name', 'description', 'parameters', 'run'].includes(key));
  if (extra.length) return `unknown field ${extra.join(', ')}`;
  const { name, description, parameters, run } = value;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) return 'name must be snake_case: a lowercase letter, then lowercase letters, digits or _ (at most 64)';
  if (reserved.has(name)) return `the name ${name} is already a tool of this agent`;
  if (typeof description !== 'string' || !description.trim() || description.length > 2000) return 'description must be a non-empty string of at most 2000 characters';
  if (!isObject(parameters) || parameters['type'] !== 'object') return 'parameters must be a JSON Schema object with "type": "object"';
  if (parameters['properties'] !== undefined && !isObject(parameters['properties'])) return 'parameters.properties must be an object';
  if (parameters['required'] !== undefined && !(Array.isArray(parameters['required']) && parameters['required'].every(item => typeof item === 'string'))) return 'parameters.required must be a list of property names';
  if (typeof run !== 'string' || !run.trim() || run.length > 2000 || /[\r\n\0]/.test(run)) return 'run must be one command line (at most 2000 characters)';
  for (const token of run.split(/\s+/)) {
    const script = token.replace(/^['"]|['"]$/g, '');
    // `.agent/x`, `./.agent/x` or an absolute `/…/.agent/x`: it must exist (its bytes are part of the approved files either way).
    if (!/(^|\/)\.agent\//.test(script)) continue;
    const found = await env.exists(script, context);
    if (!found.ok || !found.value) return `run names ${script}, which does not exist`;
  }
  return { name, description: description.trim(), parameters, run: run.trim(), path };
}

/** Files directly in `directory` with `suffix`, sorted; `missing` when the directory does not exist. */
async function filesIn(env: ExecutionEnv, directory: string, suffix: string, context: Context): Promise<string[] | 'missing' | { error: string }> {
  const listed = await env.listDir(directory, context);
  if (!listed.ok) return listed.error.code === 'not_found' ? 'missing' : { error: listed.error.message };
  return listed.value.filter(entry => entry.kind === 'file' && entry.name.endsWith(suffix)).map(entry => `${directory}/${entry.name}`).sort();
}

/** Lines added and removed between two texts (as multisets of lines): the size of an instructions change. */
function lineChanges(before: string, after: string): { added: number; removed: number } {
  const count = (text: string) => { const lines = new Map<string, number>(); for (const line of text ? text.split('\n') : []) lines.set(line, (lines.get(line) ?? 0) + 1); return lines; };
  const old = count(before), next = count(after);
  let added = 0, removed = 0;
  for (const [line, n] of next) added += Math.max(0, n - (old.get(line) ?? 0));
  for (const [line, n] of old) removed += Math.max(0, n - (next.get(line) ?? 0));
  return { added, removed };
}

type Scan = { errors: SelfEvolutionError[]; instructions: SelfEvolutionReport['instructions']; text: string; digest: string; skills: Skill[]; tools: ToolDescription[]; files: Record<string, string>; available: boolean };
const sameTool = (a: ToolDescription, b: ToolDescription) => JSON.stringify([a.description, a.parameters, a.run]) === JSON.stringify([b.description, b.parameters, b.run]);
const sameSkill = (a: Skill, b: Skill) => a.description === b.description && a.body === b.body;
const PREVIEW = 'boring.self-evolving.preview';

export function createSelfEvolution(options: SelfEvolutionOptions): SelfEvolution {
  const { name, parseSkill, skillsExtension, approval } = options;
  const pinned = approval !== undefined;
  const hostSkills = [...options.skills];
  const registries = new Set<Registry>();
  let agentSkills: Skill[] = [];
  let described = new Map<string, ToolDescription>();
  /** With approval: the instructions of the last approved reload, the only ones shown. */
  let approvedInstructions: SelfEvolutionState['instructions'] = null;
  /** With approval: the approved executable files under `.agent/` (see `SelfEvolutionState.files`). */
  let approvedFiles: Readonly<Record<string, string>> = {};
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <Value>(work: () => Promise<Value>): Promise<Value> => { const run = queue.then(work); queue = run.catch(() => undefined); return run; };

  const reloadTool = defineTool({
    name: 'reload',
    description: `Apply the changes you made to your own ${AGENT_FOLDER}/ folder in the workspace, then return what was added, changed and removed and every load error. `
      + `${INSTRUCTIONS}: standing instructions for yourself, shown after the host's instructions on every request. `
      + `${SKILLS}/<name>.md: skills (front matter with name and description between --- lines, then the instructions), loaded with load_skill. `
      + `${TOOLS}/<name>.json: your own tools, {"name": "snake_case", "description": "...", "parameters": {a JSON Schema with "type": "object"}, "run": "a command run in the workspace, for example sh ${TOOLS}/<name>.sh"}; `
      + 'the arguments arrive as one line of JSON on standard input and the command output is the result. Restore or delete the files and reload to undo a change.'
      + (pinned ? ' The person approves each reload: nothing you write there takes effect until they do.' : ''),
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: 'safe',
    executionMode: 'sequential',
    execute: async (_args, api, context): Promise<ToolExecutionResult> => pinned ? approvedReload(api, context) : resultOf(await reload(api.env, context)),
  });
  const section = agentInstructionsSection(pinned ? () => approvedInstructions : undefined);

  function build(tools: readonly ToolDescription[], files: Readonly<Record<string, string>>): Extension {
    const skills = [...hostSkills, ...agentSkills];
    const offered = skills.length ? skillsExtension(`${name}.skills`, skills) : undefined;
    return defineExtension({
      name,
      tools: [reloadTool, ...(offered?.tools ?? []), ...tools.map(tool => toolOf(tool, pinned ? files : undefined, approval))],
      sections: [...(offered?.sections ?? []), section],
    });
  }
  let current = build([], {});

  /**
   * One snapshot of `.agent/`: descriptions, skills, instructions and file digests read together. With the host's `exclusive` (its
   * workspace mutation queue) no command, editor save or guarded write lands between those reads, so a description is never bound to
   * another version's scripts. Every scan (preview, the person's `/reload`, the check after Approve) is one. Waiting for the person
   * holds nothing.
   */
  function scan(env: ExecutionEnv, context: Context): Promise<Scan> {
    return approval?.exclusive ? approval.exclusive(inner => read(inner, context)) : read(env, context);
  }

  async function read(env: ExecutionEnv, context: Context): Promise<Scan> {
    const errors: SelfEvolutionError[] = [];
    // Instructions are rendered by the section on every request; the scan reports what it will show.
    let instructions = { present: false, characters: 0, truncated: false }, shownText = '', digest = '';
    const read = await env.readTextFile(INSTRUCTIONS, context);
    if (read.ok) {
      const text = read.value.trim();
      shownText = text.slice(0, MAX_AGENT_INSTRUCTIONS);
      // The whole text, in order: any change at all (a reordering, past the cap) is a change to approve.
      digest = text ? await sha256(new TextEncoder().encode(text)) : '';
      instructions = { present: text.length > 0, characters: text.length, truncated: text.length > MAX_AGENT_INSTRUCTIONS };
    } else if (read.error.code !== 'not_found') errors.push({ path: INSTRUCTIONS, message: read.error.message });

    const skills: Skill[] = [];
    const skillFiles = await filesIn(env, SKILLS, '.md', context);
    if (typeof skillFiles === 'object' && !Array.isArray(skillFiles)) errors.push({ path: SKILLS, message: skillFiles.error });
    for (const path of Array.isArray(skillFiles) ? skillFiles : []) {
      const text = await env.readTextFile(path, context);
      if (!text.ok) { errors.push({ path, message: text.error.message }); continue; }
      let skill: Skill;
      try { skill = parseSkill(text.value); } catch (error) { errors.push({ path, message: reason(error) }); continue; }
      if ([...hostSkills, ...skills].some(other => other.name === skill.name)) { errors.push({ path, message: `a skill named ${skill.name} already exists` }); continue; }
      skills.push(skill);
    }

    const available = typeof env.exec === 'function';
    const tools: ToolDescription[] = [];
    const toolFiles = await filesIn(env, TOOLS, '.json', context);
    if (typeof toolFiles === 'object' && !Array.isArray(toolFiles)) errors.push({ path: TOOLS, message: toolFiles.error });
    const files = Array.isArray(toolFiles) ? toolFiles : [];
    if (!available && files.length) errors.push({ path: TOOLS, message: `tools are unavailable here: this environment has no exec, so ${files.length} tool description(s) were not loaded` });
    const reserved = new Set([...options.reserved, 'reload', 'load_skill']);
    for (const path of available ? files : []) {
      const text = await env.readTextFile(path, context);
      if (!text.ok) { errors.push({ path, message: text.error.message }); continue; }
      const result = await describe(env, path, text.value, new Set([...reserved, ...tools.map(tool => tool.name)]), context);
      if (typeof result === 'string') errors.push({ path, message: result }); else tools.push(result);
    }
    // The approved set: every file under `.agent/`, whatever names it (helpers anywhere in the folder, absolute paths).
    let executables: Record<string, string> = {};
    if (available) {
      const found = await executableFiles(env, context);
      if ('error' in found && typeof found.error === 'string') errors.push({ path: AGENT_FOLDER, message: `the files could not all be read: ${found.error}` });
      else executables = found as Record<string, string>;
    }
    return { errors, instructions, text: shownText, digest, skills, tools, files: executables, available };
  }

  /** What applying `found` would change, against what is in effect now. */
  function changesOf(found: Scan) {
    const next = new Map(found.tools.map(tool => [tool.name, tool]));
    const tools = {
      added: [...next.keys()].filter(key => !described.has(key)),
      changed: [...next.keys()].filter(key => described.has(key) && !sameTool(described.get(key)!, next.get(key)!)),
      removed: [...described.keys()].filter(key => !next.has(key)),
    };
    const known = new Map(agentSkills.map(skill => [skill.name, skill])), found2 = new Map(found.skills.map(skill => [skill.name, skill]));
    const skills = {
      added: [...found2.keys()].filter(key => !known.has(key)),
      changed: [...found2.keys()].filter(key => known.has(key) && !sameSkill(known.get(key)!, found2.get(key)!)),
      removed: [...known.keys()].filter(key => !found2.has(key)),
    };
    // Decisions use exact digests; line counts are only what the summary shows.
    const instructionsChanged = (approvedInstructions?.digest ?? '') !== found.digest;
    const instructions = { changed: instructionsChanged, ...lineChanges(approvedInstructions?.text ?? '', found.text) };
    const before = approvedFiles, after = found.files;
    const files = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();
    const none = !tools.added.length && !tools.changed.length && !tools.removed.length && !skills.added.length && !skills.changed.length && !skills.removed.length
      && !instructionsChanged && !files.length;
    return { tools, skills, instructions, files, none };
  }

  /** The one line the person approves: what a reload would change. */
  function summaryOf(found: Scan): string {
    const { tools, skills, instructions, files } = changesOf(found);
    const part = (label: string, names: string[]) => names.length ? `${label} ${names.join(', ')}` : '';
    const group = (title: string, change: { added: string[]; changed: string[]; removed: string[] }) => {
      const parts = [part('added', change.added), part('changed', change.changed), part('removed', change.removed)].filter(Boolean);
      return parts.length ? `${title}: ${parts.join('; ')}.` : `${title}: no change.`;
    };
    return [
      `Instructions: ${instructions.changed ? `${instructions.added} line(s) added, ${instructions.removed} removed${instructions.added || instructions.removed ? '' : ', reordered or edited'} (${found.instructions.characters} characters now).` : 'no change.'}`,
      group('Skills', skills), group('Tools', tools),
      files.length ? `Files changed: ${files.join(', ')}.` : '',
      found.errors.length ? `${found.errors.length} load error(s) will be reported.` : '',
    ].filter(Boolean).join(' ');
  }

  const stateOf = (found: Scan): SelfEvolutionState => ({
    version: 2,
    instructions: found.instructions.present ? { text: found.text, characters: found.instructions.characters, digest: found.digest } : null,
    skills: found.skills.map(skill => ({ name: skill.name, description: skill.description, body: skill.body })),
    tools: found.tools,
    files: found.files,
  });
  const fingerprint = (found: Scan) => JSON.stringify(stateOf(found));

  /** Make `found` the state in effect: native replacement in place, in every registry `install` was given. */
  async function applyFound(found: Scan, operation?: string): Promise<SelfEvolutionReport> {
    const { tools } = changesOf(found);
    const applied = report({ available: found.available, ...tools, current: found.tools.map(tool => tool.name) }, found.skills, found.instructions, found.errors);
    // The host keeps the approved state first, so what is in effect is never something a restart would not restore.
    if (approval) await approval.save(stateOf(found), { text: applied.text, ...(operation === undefined ? {} : { operation }) });
    agentSkills = found.skills;
    described = new Map(found.tools.map(tool => [tool.name, tool]));
    approvedInstructions = stateOf(found).instructions;
    approvedFiles = found.files;
    current = build(found.tools, found.files);
    // Native replacement in place: the next request of every conversation selecting this extension sees the new tools; a call
    // already running finishes with the registration it started with.
    for (const registry of registries) registry.install(current);
    return applied;
  }

  async function apply(env: ExecutionEnv | undefined, context: Context, operation?: string): Promise<SelfEvolutionReport> {
    if (env === undefined) {
      const errors = [{ path: AGENT_FOLDER, message: 'this conversation has no execution environment; nothing was changed' }];
      return report({ available: false, added: [], changed: [], removed: [], current: [...described.keys()] }, agentSkills, { present: false, characters: 0, truncated: false }, errors);
    }
    return applyFound(await scan(env, context), operation);
  }

  /** The tool result of a report; with an approval record, the record joins the details as `requireApproval` keeps it. */
  const resultOf = (applied: SelfEvolutionReport, record?: ApprovalRecord): ToolExecutionResult => ({
    content: [{ type: 'text', text: applied.text }], ...(applied.errors.some(error => error.path === AGENT_FOLDER) ? { isError: true } : {}),
    details: { ...JSON.parse(JSON.stringify(applied)), ...(record ? { [APPROVAL_DETAILS]: { ...record } } : {}) } as JsonValue,
  });
  const refused = (text: string, record: ApprovalRecord): ToolExecutionResult => ({ isError: true, content: [{ type: 'text', text }], details: { [APPROVAL_DETAILS]: { ...record } } as JsonValue });

  /**
   * The `reload` tool with approval: scan, ask the person with a summary of the changes, then apply exactly what they saw. The
   * preview is a native memo of the call, so a restart while the question waits asks about the same state; if `.agent/` changed
   * while it waited, nothing is applied and the agent is told to reload again.
   */
  async function approvedReload(api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
    const env = api.env;
    if (env === undefined) return resultOf(await serial(() => apply(undefined, context)));
    // A preview already taken by this call (before a restart) is the one the person is being asked about.
    let preview = await api.memo<{ fingerprint: string; summary: string }>(PREVIEW, context);
    if (preview === undefined) {
      const first = await serial(async () => { const found = await scan(env, context); return changesOf(found).none ? { applied: await applyFound(found) } : { found }; });
      // Nothing would change (load errors at most): nothing to approve.
      if ('applied' in first) return resultOf(first.applied);
      preview = await api.memo(PREVIEW, { fingerprint: fingerprint(first.found), summary: summaryOf(first.found) }, context);
    }
    let record: ApprovalRecord = { summary: preview.summary };
    const publish = (next: ApprovalRecord) => { record = next; return api.details({ [APPROVAL_DETAILS]: { ...next } } as JsonValue, context); };
    const decision = await askApproval(api, context, { toolName: 'reload', summary: preview.summary, publish });
    if (decision === 'denied') return refused(`${DENIED_PREFIX} reload was not run and nothing was changed.`, record);
    if (decision === 'cancelled') return refused(`${CANCELLED_PREFIX} reload was not run and nothing was changed.`, record);
    const expected = preview.fingerprint;
    return serial(async () => {
      const found = await scan(env, context);
      if (fingerprint(found) !== expected) return refused(`Nothing was changed: ${AGENT_FOLDER}/ changed while the person was deciding. Call reload again to ask about the new state.`, record);
      return resultOf(await applyFound(found), record);
    });
  }

  function report(tools: SelfEvolutionReport['tools'], skills: readonly Skill[], instructions: SelfEvolutionReport['instructions'], errors: SelfEvolutionError[]): SelfEvolutionReport {
    const lines = [
      `Reloaded ${AGENT_FOLDER}/ (${name}).`,
      tools.available
        ? `Tools added: ${list(tools.added)}. Changed: ${list(tools.changed)}. Removed: ${list(tools.removed)}. Now: ${list(tools.current)}.`
        : 'Tools: unavailable in this environment (no exec).',
      `Skills: ${list(skills.map(skill => skill.name))}.`,
      `Instructions: ${instructions.present ? `${INSTRUCTIONS}, ${instructions.characters} characters${instructions.truncated ? ` (only the first ${MAX_AGENT_INSTRUCTIONS} are shown)` : ''}, after the host's instructions` : 'none'}.`,
      errors.length ? `Errors (${errors.length}):\n${errors.map(error => `- ${error.path}: ${error.message}`).join('\n')}` : 'Errors: none.',
    ];
    return { extension: name, tools, skills: skills.map(skill => skill.name), instructions, errors, text: lines.join('\n') };
  }

  const reload = (env: ExecutionEnv | undefined, context: Context, options: { readonly operation?: string } = {}) => serial(() => apply(env, context, options.operation));
  // `apply`, `scan` and `applyFound` run inside `serial`: reloads, restores and previews never interleave.

  /** Install the saved approved state as it was; nothing is read from `.agent/`. */
  const restore = () => serial(async () => {
    const state = await approval!.load();
    const skills = (state?.skills ?? []).map(skill => ({ name: skill.name, description: skill.description, body: skill.body }));
    // A state saved before the executable set was recorded (version 1) approved no files: its tools refuse until the next reload.
    const found: Scan = { errors: [], text: state?.instructions?.text ?? '', digest: state?.instructions?.digest ?? '', skills, tools: [...state?.tools ?? []], files: { ...state?.version === 2 ? state.files : {} }, available: true,
      instructions: { present: Boolean(state?.instructions), characters: state?.instructions?.characters ?? 0, truncated: (state?.instructions?.characters ?? 0) > MAX_AGENT_INSTRUCTIONS } };
    agentSkills = found.skills;
    described = new Map(found.tools.map(tool => [tool.name, tool]));
    approvedInstructions = state?.instructions ?? null;
    approvedFiles = found.files;
    current = build(found.tools, found.files);
    for (const registry of registries) registry.install(current);
    return report({ available: true, added: [], changed: [], removed: [], current: [...described.keys()] }, found.skills, found.instructions, []);
  });

  return {
    current: () => current,
    skills: () => [...hostSkills, ...agentSkills],
    install: registry => { registries.add(registry); registry.install(current); },
    reload,
    ...(approval ? { restore } : {}),
  };
}
