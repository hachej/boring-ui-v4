// MCP servers as native Pi tools, through Pi's own MCP client (@earendil-works/pi-mcp). No Boring MCP layer: the host builds the
// transport (stdio, Streamable HTTP with its own fetch and credentials, OAuth from `@earendil-works/pi-mcp/oauth`) and owns the policy.
//   - only the tools the host allows are offered (whatever else the server lists is absent);
//   - only the tools the host lists as `readOnly` run at once; the server's own annotations decide nothing;
//   - every other tool asks the person through the existing approval gate (`requireApproval`) and is `replay: 'unsafe'`, so a crash
//     after the call started reports "outcome unknown" instead of calling the server again;
//   - results are capped at `maxResult` characters of text.
// The tools are ordinary native tool registrations: a host passes them to its agent like any other (a standard-agent part).
import { McpClient, toLlmContent } from '@earendil-works/pi-mcp';
import { requireApproval } from '@boring/agent/approval';
import { jsonSchemaTool } from '@boring/agent/agents';

export const MAX_MCP_RESULT = 20_000;

function capped(content, max) {
  let left = max;
  return content.map(part => {
    if (part.type !== 'text') return part;
    const text = part.text.length > left ? `${part.text.slice(0, left)}\n[Truncated: the result is longer than ${max} characters.]` : part.text;
    left = Math.max(0, left - part.text.length);
    return { ...part, text };
  });
}

/**
 * @param {{ id: string, transport: import('@earendil-works/pi-mcp').McpTransport, allow: string[], readOnly?: string[], maxResult?: number }} server
 * @returns {Promise<{ tools: object[], close: () => Promise<void> }>} native tools named `<id>_<tool>`, and the connection to close
 */
export async function connectMcpTools({ id, transport, allow, readOnly = [], maxResult = MAX_MCP_RESULT }) {
  const client = new McpClient({ name: 'boring-agent', version: '0.0.0' });
  await client.connect(transport);
  const reads = new Set(readOnly);
  const tools = (await client.listTools()).filter(tool => allow.includes(tool.name)).map(tool => {
    // The server's input schema as Pi's parameters: the Harness validates every call against it before anything reaches the server.
    const native = jsonSchemaTool({
      name: `${id}_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64),
      description: tool.description ?? tool.name,
      // Providers require an object schema (jsonSchemaTool adds an empty `properties` when the server lists none).
      parameters: { ...tool.inputSchema, type: 'object' },
      replay: reads.has(tool.name) ? 'safe' : 'unsafe',
      execute: async (args, _api, context) => {
        const result = await client.callTool(tool.name, args ?? {}, context.abortSignal ? { signal: context.abortSignal } : {});
        // MCP reports a tool's own failure in the result, not as a protocol error.
        return { content: capped(toLlmContent(result), maxResult), isError: result.isError === true };
      },
    });
    return reads.has(tool.name) ? native : requireApproval(native, { summarize: args => `${id}: ${tool.name} ${JSON.stringify(args)}` });
  });
  return { tools, close: () => client.close() };
}
