// Variant `team`: ONE agent on the studio's one harness, used by several fictional people, each in their own workspace. Nothing about
// the agent is per person: its file guard, `present`, canvas tools and bash resolve the workspace of each call the way Pi resolves the
// environment (`@boring/agent/workspaces`), from the person who owns the conversation. The viewers (file tree, file viewer, uploads,
// resources) resolve the same workspace from the authenticated request. Workspaces open on first use and close when idle.
//
// Where the files live: one SQLite file in the data directory, one workspace (file system + journal) per person in it, with just-bash
// over the same rows, like the Cloudflare recipe. The harbour MCP server is reached with each person's own fictional credential.
// No git (one repository per person would be one more per-person resource) and no self-evolution (its extension is per workspace:
// a host that wants it per person uses one harness per owner, `@boring/agent/harness-pool`).
import { join } from 'node:path';
import { openNodeConnection } from '@boring/files/sqlite';
import { openSqliteFileSystem } from '@boring/files/sqlite-filesystem';
import { createWorkspaceJournal } from '@boring/files/journal';
import { createWorkspaceProvider } from '@boring/files/workspace';
import { createVirtualWorkspace } from '@boring/execution/virtual';
import { fictionalHarbourServer } from '../fixtures/mcp-server.mjs';

const ROOT = '/workspace';
const README = '# Fictional team workspace\n\nEverything here is invented demo content. Only you and your agent see the files in it.\n';

export default host => ({
  id: 'team', title: 'Team', order: 20,
  description: 'One agent for several people: each person has their own workspace and connected services, resolved per call like the environment.',
  available: true,
  capabilities: ['workspace', 'shell'],
  // Every person's calls reach the harbour with that person's credential (the studio's fictional vault, `credentials` in server.mjs).
  mcp: { servers: [{ id: 'harbour', allow: ['tide_times', 'book_mooring'], readOnly: ['tide_times'], perPerson: true, transport: credential => fictionalHarbourServer({ credential }).transport }] },
  async open() {
    const connection = openNodeConnection(join(host.directory, 'team-workspaces.sqlite'));
    const journal = createWorkspaceJournal(connection);
    return {
      root: ROOT,
      /** Idle workspaces close after this long (STUDIO_TEAM_IDLE_MS; the journey shortens it). */
      idleMs: Number(process.env.STUDIO_TEAM_IDLE_MS ?? 10 * 60_000),
      /**
       * Open one person's workspace: their files (rows of `workspace = <person>`), one provider over them and just-bash over the same
       * file system. The provider's identity names the person, so receipts and history never mix between people.
       */
      async workspace(person, context) {
        const fs = openSqliteFileSystem({ connection, workspace: person, cwd: ROOT });
        const files = createWorkspaceProvider({ identity: { providerId: 'workspace', instanceId: `team-${person}`, incarnation: fs.incarnation, viewId: 'published' }, fs, journal });
        if (!(await fs.exists(`${ROOT}/README.md`, context)).value) await fs.writeFile(`${ROOT}/README.md`, README, context);
        const shell = createVirtualWorkspace({ providerId: 'studio-team', fs });
        const lease = await shell.acquire({ operationId: `team-${person}`, input: { cwd: ROOT } }, context);
        return { id: `team-${person}`, files, root: ROOT, env: lease.environment,
          close: async () => { await lease.release(context); shell.dispose(); } };
      },
      close: async () => { connection.close(); },
    };
  },
});
