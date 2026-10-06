// The approved self-evolution state of one Durable Object (what its person approved in `.agent/`) and the person's `/reload`, in the
// object's own SQLite. Only approved state takes effect; the object installs it again when it opens (`DefinedAgent.restore`).
export function approvedState(connection, workspace) {
  const tables = () => connection.exec(`CREATE TABLE IF NOT EXISTS boring_self_evolution (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS boring_reload_commands (operation TEXT PRIMARY KEY, report TEXT NOT NULL, at INTEGER NOT NULL) STRICT`);
  return {
    load: async () => { tables(); const row = connection.get('SELECT state FROM boring_self_evolution WHERE id = 1'); return row ? JSON.parse(String(row.state)) : undefined; },
    // The approved state and, for the person's `/reload`, the record that this message applied it: one write, so a redelivered
    // message finds the record and is answered from it, never by reloading what `.agent/` holds by then.
    save: async (state, { text, operation }) => connection.transaction('write', () => {
      tables();
      connection.run('INSERT INTO boring_self_evolution (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state', JSON.stringify(state));
      if (operation !== undefined) connection.run('INSERT OR IGNORE INTO boring_reload_commands (operation, report, at) VALUES (?, ?, ?)', operation, text, Date.now());
    }),
    // An agent-written tool checks the approved files and runs inside one operation of the workspace's mutation queue.
    exclusive: work => workspace.exclusive(work),
    /** The report a `/reload` message got when it applied, or undefined. */
    applied: operation => { tables(); return connection.get('SELECT report FROM boring_reload_commands WHERE operation = ?', operation)?.report; },
  };
}

/**
 * The person's `/reload` (a WhatsApp message `requestId`): the same reload as the agent's tool, applied at once (the person asking is
 * the approval). The state and the record that this message applied it are saved in one write (`approvedState.save`), so a
 * redelivered message is answered with the report it got the first time; nothing is rescanned and nothing newer is applied.
 */
export async function reloadCommand({ approved, agent, env, requestId, context }) {
  const recorded = approved.applied(requestId);
  if (recorded !== undefined) return recorded;
  return (await agent.reload(await env(), context, { operation: requestId })).text;
}
