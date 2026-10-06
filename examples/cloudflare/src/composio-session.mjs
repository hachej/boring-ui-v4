// One Composio Tool Router session per person: the person's agent reaches Composio's apps through its own session, whose Composio
// `user_id` is the person's stable id (their object name), so their connected accounts are theirs only. The owner keeps the session
// configured in MCP_SERVERS.
//
// The API, checked against Composio's reference (docs.composio.dev/reference/api-reference/tool-router/postToolRouterSession, 2026-10):
//   POST https://backend.composio.dev/api/v3.1/tool_router/session   header x-api-key: <COMPOSIO_API_KEY>
//   body { user_id, manage_connections: { enable: true }, toolkits?: { enable: [...] } }
//   201 { session_id, mcp: { type: 'http', url }, tool_router_tools, ... }
// The MCP URL is then called with the same x-api-key header (as the owner's MCP_SERVERS entry does). This is the only place that
// speaks this API: if Composio changes it, change this function.

export const COMPOSIO_ORIGIN = 'https://backend.composio.dev';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Create a Tool Router session for `userId`. `toolkits` (optional) limits it to those toolkit slugs. `origin` replaces Composio's API
 * origin for local journeys only (COMPOSIO_API_ORIGIN, loopback). Returns `{ sessionId, url }`; throws without the key in its message.
 */
export async function createToolRouterSession({ apiKey, userId, toolkits, origin = COMPOSIO_ORIGIN, fetcher = fetch }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOOPBACK.has(base.hostname))) throw new Error('Composio origin must be https');
  const response = await fetcher(new URL('/api/v3.1/tool_router/session', base), {
    method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ user_id: userId, manage_connections: { enable: true }, ...(toolkits?.length ? { toolkits: { enable: toolkits } } : {}) }),
  });
  if (!response.ok) throw new Error(`Composio session creation failed (${response.status})`);
  const body = await response.json();
  const url = new URL(body?.mcp?.url ?? '');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new Error('Composio returned a session URL that is not https');
  return { sessionId: String(body.session_id ?? ''), url: url.href };
}
