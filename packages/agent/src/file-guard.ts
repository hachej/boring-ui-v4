import { defineDoc, defineExtension, wrapTool } from '@earendil-works/pi-durable';
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import type { Context } from '@earendil-works/chord';
import type { ResourceAccess } from '@boring/files';
import type { WorkspaceResourceProvider } from '@boring/files/workspace';

/*
 * The guard for Pi's own `read`, `write` and `edit`. It adds no tool and no file API: it wraps the native tools (public
 * `wrapTool`) so that the agent cannot overwrite what it has not seen.
 *
 *  - Every wrapped call runs inside the workspace provider's mutation queue, so a viewer save cannot land between `edit`'s
 *    internal read and its write.
 *  - A genuine `read` call records the file's revision (the provider's Git blob id of the bytes) as this conversation's
 *    last-read revision of the path, in a native conversation document: it survives restarts. `edit`'s internal read is not
 *    a `read` call and never records anything.
 *  - `write` and `edit` of a file that exists are refused unless the conversation read it and its revision still equals the
 *    last-read one. Creating a file is allowed only while it is absent. After a successful `write` or `edit` the baseline is
 *    the revision just written.
 *
 * Pi's `edit` matches `oldText` exactly first and only then falls back to a fuzzy match (Unicode normalisation, trailing
 * whitespace, smart quotes, dashes and special spaces); that is Pi's behaviour and the guard does not change it. A shell write
 * (`bash`) is not intercepted, but it changes the revision, so the next `write` or `edit` of that file is refused until read.
 */

type Baselines = { revisions: Record<string, string> };
/** Conversation document: path (relative to the workspace root) to the revision this conversation last read or wrote. */
export const lastReadRevisions = defineDoc<Baselines>({
  kind: 'boring.files.last-read', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ revisions: {} }),
});

/** The revision of `path` (relative to the workspace root) this conversation last read or wrote, or undefined. Also what host tools over workspace files (such as the canvas tools) check. */
export const lastReadRevision = async (api: ToolExecutionApi, path: string, context: Context): Promise<string | undefined> =>
  (await api.snapshot(lastReadRevisions, api.conversationId, context))?.revisions[path];
/** Record `revision` as the conversation's baseline for `path`, durably. */
export const recordRevision = (api: ToolExecutionApi, path: string, revision: string, context: Context): Promise<void> => api.commit(async tx => {
  const doc = await tx.doc(lastReadRevisions, api.conversationId);
  doc.revisions[path] = revision;
}, context);

export interface FileGuardOptions {
  /** The workspace provider the viewers use: its queue serialises the calls, its reads name the revisions. */
  readonly files: Pick<WorkspaceResourceProvider, 'providerId' | 'read' | 'queue'>;
  /** The workspace root as the call's ExecutionEnv names it (the provider's `fs.cwd`). Paths outside it are refused. */
  readonly root: string;
  readonly resolveAccess: (api: ToolExecutionApi, context: Context) => ResourceAccess | Promise<ResourceAccess>;
}

type Observed = { readonly kind: 'file'; readonly revision: string } | { readonly kind: 'missing' } | { readonly kind: 'refused'; readonly reason: string };
type Args = { readonly path: string };

const refusal = (text: string): ToolExecutionResult => ({ content: [{ type: 'text', text }], isError: true });
// The same normalisation as Pi's tool paths: a leading "@" and special spaces.
const normalised = (path: string) => { const spaced = path.replace(/[  -   　]/g, ' '); return spaced.startsWith('@') ? spaced.slice(1) : spaced; };

/** The guard as a native extension. Select it after the extension(s) that register `read`, `write` and `edit`. */
export function createFileGuard(options: FileGuardOptions) {
  const { files, resolveAccess } = options;
  const root = options.root.replace(/\/+$/, '');
  if (!root.startsWith('/')) throw new TypeError('The guard needs the absolute workspace root');

  async function relative(api: ToolExecutionApi, path: string, context: Context): Promise<string | undefined> {
    if (api.env === undefined) return undefined;
    const absolute = getOrThrow(await api.env.absolutePath(normalised(path), context));
    return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : undefined;
  }
  async function observe(path: string, access: ResourceAccess): Promise<Observed> {
    const read = await files.read({ target: { resource: { providerId: files.providerId, path }, view: { kind: 'published' } }, revision: { kind: 'latest' } }, access);
    if (read.kind === 'available') return { kind: 'file', revision: read.snapshot.ref.revision };
    if (read.kind === 'missing') return { kind: 'missing' };
    return { kind: 'refused', reason: read.reason };
  }
  function guarded<Tool extends ToolRegistration>(tool: Tool, mode: 'read' | 'write' | 'edit'): Tool {
    const execute = async (args: Args, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
      const run = () => (tool.execute as (args: Args, api: ToolExecutionApi, context: Context) => Promise<ToolExecutionResult>)(args, api, context);
      const access = { ...await resolveAccess(api, context) };
      const path = await relative(api, args.path, context);
      if (path === undefined) return mode === 'read' ? run() : refusal(`Refused: ${args.path} is outside the workspace.`);
      return files.queue.run(async () => {
        const before = await observe(path, access);
        if (mode === 'read') {
          const result = await run();
          if (result.isError || before.kind !== 'file') return result;
          // Record only the bytes the model saw: a change during the call (a shell) leaves the baseline alone.
          const after = await observe(path, access);
          if (after.kind === 'file' && after.revision === before.revision) await recordRevision(api, path, after.revision, context);
          return result;
        }
        if (before.kind === 'refused') return refusal(`Refused: ${path} cannot be changed here (${before.reason}).`);
        if (before.kind === 'file') {
          const known = await lastReadRevision(api, path, context);
          if (known === undefined) return refusal(`Refused: ${path} already exists and you have not read it in this conversation. Read it with the read tool, then make your change.`);
          if (known !== before.revision) return refusal(`Refused: ${path} changed since you last read it (the person or another process saved it). Read it again with the read tool, then redo your change on top of what is there now.`);
        }
        const result = await run();
        if (!result.isError) {
          const after = await observe(path, access);
          if (after.kind === 'file') await recordRevision(api, path, after.revision, context);
        }
        return result;
      });
    };
    return { ...tool, execute } as Tool;
  }

  return defineExtension({
    name: 'boring.files.guard',
    wraps: [
      wrapTool(createReadTool() as ToolRegistration, tool => guarded(tool, 'read')),
      wrapTool(createWriteTool() as ToolRegistration, tool => guarded(tool, 'write')),
      wrapTool(createEditTool() as ToolRegistration, tool => guarded(tool, 'edit')),
    ],
  });
}
