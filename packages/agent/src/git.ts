import type { GitRepository } from '@boring/files/git';
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';

type DiffVersion = { readonly oid: string; readonly mode: number; readonly bytes: Uint8Array } | null;
/** Model-facing form of a diff side: decoded text, or a binary marker without the bytes. */
function readable(version: DiffVersion) {
  if (!version) return null;
  const { oid, mode, bytes } = version;
  try { return { oid, mode, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
  catch { return { oid, mode, binary: true, size: bytes.length }; }
}

/** The host passes the same authorized working repository used by other callers. Git mutations have no replay receipts. */
export function createGitTool(repository: GitRepository) {
  const view = Type.Union([
    Type.Object({ kind: Type.Literal('tree'), ref: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Union([Type.Literal('index'), Type.Literal('worktree')]) }, { additionalProperties: false }),
  ]);
  return defineTool({
    name: 'working_git',
    description: 'Operate on the bound working repository. Removal affects only the index. Mutations may leave partial effects and are not publication.',
    replay: 'unsafe',
    parameters: Type.Union([
      Type.Object({ operation: Type.Union([Type.Literal('init'), Type.Literal('status'), Type.Literal('log'), Type.Literal('branches')]) }, { additionalProperties: false }),
      Type.Object({ operation: Type.Union([Type.Literal('add'), Type.Literal('remove')]), path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      Type.Object({ operation: Type.Literal('commit'), message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      Type.Object({ operation: Type.Union([Type.Literal('branch'), Type.Literal('checkout')]), ref: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      Type.Object({ operation: Type.Literal('diff'), before: view, after: view }, { additionalProperties: false }),
    ]),
    execute: async (args, _api, context) => {
      const signal = context.abortSignal;
      let value: unknown;
      switch (args.operation) {
        case 'init': value = await repository.init(signal); break;
        case 'status': value = await repository.status(signal); break;
        case 'log': value = await repository.log(signal); break;
        case 'branches': value = await repository.branches(signal); break;
        case 'add': value = await repository.add(args.path, signal); break;
        case 'remove': value = await repository.remove(args.path, signal); break;
        case 'commit': value = await repository.commit(args.message, signal); break;
        case 'branch': value = await repository.branch(args.ref, signal); break;
        case 'checkout': value = await repository.checkout(args.ref, signal); break;
        case 'diff': value = (await repository.diff(args.before, args.after, signal)).map(change => ({ path: change.path, before: readable(change.before), after: readable(change.after) })); break;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ operation: args.operation, value: value ?? null }) }] };
    },
  });
}
