import { defineExtension } from '@earendil-works/pi-durable';
import type { AgentChange, Conversation, ConversationCreateOptions, Extension, Harness, Registry, ToolRegistration } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { createSelfEvolution } from './self-evolving.js';
import type { SelfEvolutionReport } from './self-evolving.js';
import { NAME, createSkillsExtension, parseSkill, validSkill } from './skills.js';
import type { Skill } from './skills.js';

export type { SelfEvolutionError, SelfEvolutionReport } from './self-evolving.js';
export { createSkillsExtension, parseSkill } from './skills.js';
export type { Skill } from './skills.js';
export { jsonSchemaTool } from './json-schema-tool.js';
export type { JsonObjectSchema, JsonSchemaToolOptions } from './json-schema-tool.js';

/** One agent as plain data over native Pi pieces. It is a convenience, not another registry or lifecycle. */
export interface AgentSpec {
  /** Stable name; it becomes the native extension name `agent.<id>`. */
  readonly id: string;
  readonly model: NonNullable<AgentChange['model']>;
  readonly instructions?: string;
  readonly thinkingLevel?: NonNullable<AgentChange['thinkingLevel']>;
  /** Tools owned by this agent. */
  readonly tools?: readonly ToolRegistration[];
  /** Additional native extensions this agent selects, for example Pi's `CodingTools`. */
  readonly extensions?: readonly Extension[];
  readonly skills?: readonly Skill[];
  /** Directory within the harness environment. */
  readonly cwd?: string;
  /**
   * Let the agent keep its own instructions, skills and tools in `.agent/` of its workspace and apply them with `reload`
   * (docs/architecture/SELF-EVOLUTION.md). Off by default: without it nothing reads `.agent/` (SELF-1).
   */
  readonly selfEvolving?: boolean;
  /** The workspace instance this agent works in; names the per-workspace extension `self-evolving:<workspace>`. Required with `selfEvolving`. */
  readonly workspace?: string;
}

export interface DefinedAgent {
  readonly id: string;
  /** Every native extension this agent selects, own extension first; with `selfEvolving` the per-workspace extension (as first defined) last. */
  readonly extensions: readonly Extension[];
  /** Name and description of this agent's skills, for hosts that offer them in a `/` menu. */
  readonly skills: readonly Pick<Skill, 'name' | 'description'>[];
  /** Native per-conversation agent configuration. */
  readonly agent: AgentChange;
  /** Install this agent's extensions in a host registry. Installing the same extension twice replaces it in place. */
  readonly install: (registry: Registry) => void;
  /**
   * With `selfEvolving` only: rescan `.agent/` through `env` (the conversation's environment, or the workspace's on open) and replace
   * the per-workspace extension in every registry `install` was given. The `reload` tool and a host's `/reload` command call this.
   */
  readonly reload?: (env: ExecutionEnv | undefined, context: Context) => Promise<SelfEvolutionReport>;
  /** Create a native conversation configured as this agent. The host keeps the native handle. */
  readonly createConversation: (harness: Harness, context: Context, options?: Partial<Pick<ConversationCreateOptions, 'ownership' | 'init'>>) => Promise<Conversation>;
}

/** Turn an agent described as data into native extensions and a native agent configuration. */
export function defineAgent(spec: AgentSpec): DefinedAgent {
  if (!NAME.test(spec.id)) throw new TypeError(`Invalid agent id: ${spec.id}`);
  if (spec.selfEvolving && (typeof spec.workspace !== 'string' || !spec.workspace.trim())) throw new TypeError(`Agent ${spec.id}: selfEvolving needs the workspace it evolves in`);
  // Self-evolving (SELF-3): Pi renders native `instructions` after every extension section, so the host's instructions become the first
  // section of the agent's own (first) extension instead, and the agent-written section, in the last extension, comes after them.
  const base = spec.selfEvolving && spec.instructions !== undefined ? spec.instructions : undefined;
  const own: Extension[] = [];
  if (spec.tools?.length || base !== undefined) {
    own.push(defineExtension({ name: `agent.${spec.id}`, tools: [...spec.tools ?? []], sections: base === undefined ? [] : [{ key: 'host-instructions', render: () => base }] }));
  }
  if (spec.skills?.length && !spec.selfEvolving) own.push(createSkillsExtension(`agent.${spec.id}.skills`, spec.skills));
  // The skills of a self-evolving agent live in its per-workspace extension, so agent-written skills join them on reload.
  const evolution = spec.selfEvolving ? createSelfEvolution({
    name: `self-evolving:${spec.workspace}`, skills: (spec.skills ?? []).map(validSkill), parseSkill, skillsExtension: createSkillsExtension,
    reserved: [...(spec.tools ?? []), ...(spec.extensions ?? []).flatMap(extension => extension.tools ?? [])].map(tool => tool.name),
  }) : undefined;
  const initial = evolution?.current();
  const extensions = Object.freeze([...own, ...(spec.extensions ?? []), ...(initial ? [initial] : [])]);
  if (new Set(extensions.map(extension => extension.name)).size !== extensions.length) throw new TypeError(`Agent ${spec.id} selects one extension name twice`);
  const agent: AgentChange = Object.freeze({
    model: spec.model, extensions,
    ...(spec.instructions === undefined || base !== undefined ? {} : { instructions: spec.instructions }),
    ...(spec.thinkingLevel === undefined ? {} : { thinkingLevel: spec.thinkingLevel }),
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
  });
  const listed = (skills: readonly Skill[]) => Object.freeze(skills.map(skill => Object.freeze({ name: skill.name, description: skill.description.trim() })));
  const hostSkills = listed(spec.skills ?? []);
  return Object.freeze({
    id: spec.id, extensions, agent,
    get skills() { return evolution ? listed(evolution.skills()) : hostSkills; },
    install: (registry: Registry) => { for (const extension of extensions) { if (extension === initial) evolution!.install(registry); else registry.install(extension); } },
    ...(evolution ? { reload: evolution.reload } : {}),
    createConversation: (harness: Harness, context: Context, options: Partial<Pick<ConversationCreateOptions, 'ownership' | 'init'>> = {}) =>
      harness.createConversation({ ownership: options.ownership ?? { kind: 'ownerless' }, agent, ...(options.init ? { init: options.init } : {}) }, context),
  });
}
