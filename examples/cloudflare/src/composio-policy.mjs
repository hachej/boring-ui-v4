// Approval policy for Composio's Tool Router session (one MCP server whose meta-tools reach every Composio app).
// The host decides everything here; Composio's annotations are hints and count for nothing.
// - Reads (run at once, replay-safe): COMPOSIO_SEARCH_TOOLS, COMPOSIO_GET_TOOL_SCHEMAS, COMPOSIO_WAIT_FOR_CONNECTIONS.
// - COMPOSIO_MANAGE_CONNECTIONS runs without asking but is not replayed: it only makes a connect link, and nothing changes until
//   the person consents on the provider's page (the agent sends that link on WhatsApp).
// - COMPOSIO_MULTI_EXECUTE_TOOL asks the person unless every tool it runs is in READ_TOOLS, an explicit list of reviewed
//   read-only tool slugs (no guessing from names: GOOGLESHEETS_FIND_REPLACE "finds" and writes). Everything else asks, including
//   reads of other apps until they are reviewed and added. The approval headline names the exact tools and their arguments.

/** Reviewed read-only tools: Composio's Gmail toolkit lists these with readOnlyHint, and their names and docs say they only read. */
export const READ_TOOLS = new Set([
  'GMAIL_FETCH_EMAILS', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'GMAIL_LIST_THREADS', 'GMAIL_LIST_LABELS',
  'GMAIL_LIST_DRAFTS', 'GMAIL_GET_PROFILE', 'GMAIL_GET_ATTACHMENT', 'GMAIL_GET_CONTACTS', 'GMAIL_GET_PEOPLE', 'GMAIL_SEARCH_PEOPLE',
]);
const META_READS = new Set(['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'COMPOSIO_WAIT_FOR_CONNECTIONS']);
const EXECUTE = 'COMPOSIO_MULTI_EXECUTE_TOOL', CONNECT = 'COMPOSIO_MANAGE_CONNECTIONS';
const calls = args => (Array.isArray(args?.tools) ? args.tools : []);

/** The options `createMcpExtension` takes for a Composio Tool Router server. `extraReads` adds reviewed read-only slugs. */
export function composioPolicy(extraReads = []) {
  const reads = new Set([...READ_TOOLS, ...extraReads]);
  return {
    readOnly: tool => META_READS.has(tool.name),
    approve: tool => !META_READS.has(tool.name) && tool.name !== CONNECT,
    approveCall: (tool, args) => tool.name !== EXECUTE || !(calls(args).length > 0 && calls(args).every(call => typeof call?.tool_slug === 'string' && reads.has(call.tool_slug))),
    summarize: (tool, args) => tool.name === EXECUTE
      ? `Run ${calls(args).map(call => `${call?.tool_slug ?? '?'} ${JSON.stringify(call?.arguments ?? {}).slice(0, 160)}`).join('; ') || '(no tools)'}`
      : `${tool.name}: ${JSON.stringify(args).slice(0, 300)}`,
  };
}
