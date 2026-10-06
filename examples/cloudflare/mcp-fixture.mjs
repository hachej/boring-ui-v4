// A fictional notes MCP server for the MCP journey: Streamable HTTP on 127.0.0.1, stateless, behind an `x-api-key` check. It records
// every request's key check and every tool call, so the journey can prove what reached it. Fictional content only.
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const NOTES = [
  { title: 'Fictional heron sighting', body: 'A grey heron stood by the fictional pond at dawn.' },
  { title: 'Fictional otter count', body: 'Seven fictional otters were counted near the old mill.' },
];

/** @param {{ apiKey: string }} options */
export async function startNotesServer({ apiKey }) {
  const calls = [], requests = [], notes = [...NOTES];
  const build = () => {
    const server = new McpServer({ name: 'fictional-notes', version: '1.0.0' });
    server.registerTool('search_notes', { title: 'Search notes', description: 'Search the fictional notes for a word; returns the matching notes with their titles.',
      inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } }, async ({ query }) => {
      calls.push({ name: 'search_notes', args: { query } });
      const found = notes.filter(note => `${note.title} ${note.body}`.toLowerCase().includes(String(query).toLowerCase()));
      return { content: [{ type: 'text', text: found.length ? found.map(note => `Title: ${note.title}\nBody: ${note.body}`).join('\n\n') : 'No fictional notes match.' }] };
    });
    server.registerTool('create_note', { title: 'Create note', description: 'Create a fictional note with a title and a body.',
      inputSchema: { title: z.string(), body: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false } }, async ({ title, body }) => {
      calls.push({ name: 'create_note', args: { title, body } });
      notes.push({ title, body });
      return { content: [{ type: 'text', text: `Created the note "${title}".` }] };
    });
    // Listed by the server but never allowed by the host: it must not reach the agent.
    server.registerTool('delete_all_notes', { description: 'Delete every fictional note.', inputSchema: {}, annotations: { destructiveHint: true } }, async () => {
      calls.push({ name: 'delete_all_notes', args: {} });
      notes.length = 0;
      return { content: [{ type: 'text', text: 'Deleted.' }] };
    });
    return server;
  };
  const http = createServer(async (request, response) => {
    const keyOk = request.headers['x-api-key'] === apiKey;
    requests.push({ method: request.method, keyOk });
    if (!keyOk) { response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid api key"}'); return; }
    if (request.method !== 'POST' || !request.url?.startsWith('/mcp')) { response.writeHead(405, { allow: 'POST' }).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, calls, requests, notes, close: () => new Promise(resolve => http.close(resolve)) };
}
