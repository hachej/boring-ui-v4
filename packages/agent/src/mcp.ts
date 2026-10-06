import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import type { ConversationId, Extension, RegistryReader, ToolRegistration } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { requireApproval } from './approval.js';

/**
 * MCP servers as native Pi tools, whatever client reaches them.
 *
 * The host builds a `McpToolSource` from its own MCP client (Cloudflare's `MCPClientManager`, the official SDK client, a
 * fixture…); credentials and OAuth stay inside that client. This adapter turns the source's tools into one native extension,
 * installed in the normal registry and selected per conversation with the native `configure`, so granting a conversation an
 * MCP server is selecting its extension. It adds no second registry, scheduler or transport.
 *
 * - Only tools the host allows are exposed (`allow`), each named `<source>__<tool>`. Descriptions and schemas come from the
 *   server and are untrusted: they never widen what is allowed, and a changed tool list needs a new `createMcpExtension`.
 *   Each listed tool is copied and frozen once, before any host policy runs; `tools`, the policy callbacks, dispatch and
 *   summaries all use that copy, so a client that changes its own tool objects later cannot redirect an allowed call.
 * - Server annotations (`readOnlyHint` and the rest) are untrusted hints and decide nothing. Only the host's `readOnly` marks
 *   a tool as a read: by default every tool asks the person first (`requireApproval`) and is `replay: 'unsafe'`, so a call
 *   interrupted by a crash reports an unknown outcome instead of running again. Only a host-declared read that does not ask
 *   replays safely.
 * - Results become Pi text and image content, capped in size (text, images, and at most 64 blocks; empty text is dropped); `redact` removes secrets from result text and
 *   from errors the client throws, which come back as a bounded error result, never as a raw exception.
 *
 * Selection: a conversation made by `defineAgent` selects exactly its agent's extensions, so an MCP extension reaches it only
 * through `configure({ extensions: { add } })`. A Harness without `settings.extensions` gives conversations that never chose
 * every installed extension; keep MCP out of that default with `settings: withoutMcpByDefault(registry)`. `granted`, when
 * given, is also checked inside every call, so a selection made by mistake still cannot reach the server.
 */

/** One tool as an MCP server lists it (`tools/list`). */
export interface McpTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: { readonly type?: string; readonly properties?: Record<string, unknown>; readonly required?: readonly string[]; readonly [key: string]: unknown };
  readonly annotations?: { readonly title?: string; readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly idempotentHint?: boolean; readonly openWorldHint?: boolean };
}

/** One content block of an MCP tool result (`tools/call`). Other block types are summarized as text. */
export type McpContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: string; readonly [key: string]: unknown };

export interface McpCallResult {
  readonly content?: readonly McpContent[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** Who a call is for: a per-person source (for example one Composio user) selects its account from it. */
export interface McpCallContext {
  readonly conversationId: ConversationId;
  readonly signal?: AbortSignal;
}

/** What an MCP client gives this adapter. Trusted host code; function properties, so implementations are checked contravariantly. */
export interface McpToolSource {
  /** Stable and short: lowercase words joined by single `-` or `_` (no `__`), the tool name prefix and the extension `mcp.<id>`. */
  readonly id: string;
  readonly listTools: (signal?: AbortSignal) => Promise<readonly McpTool[]>;
  readonly callTool: (name: string, args: Record<string, unknown>, call: McpCallContext) => Promise<McpCallResult>;
}

export interface McpExtensionOptions {
  readonly source: McpToolSource;
  /** The upstream tool names to expose, exactly. Default: none, so the host must decide (`'all'` exposes everything listed). */
  readonly allow: readonly string[] | 'all';
  /** Host policy: which tools only read. Default: none. Server annotations never count. */
  readonly readOnly?: (tool: McpTool) => boolean;
  /** Whether a tool's calls need the person's approval. Default: every tool the host's `readOnly` does not mark as a read. */
  readonly approve?: (tool: McpTool) => boolean;
  /**
   * For a tool that needs approval, whether this particular call does, from its arguments (for example a generic "execute"
   * meta-tool whose arguments name read-only upstream tools). Synchronous; default: every call asks. Return true when unsure.
   */
  readonly approveCall?: (tool: McpTool, args: Record<string, unknown>) => boolean;
  /** The approval headline for a call. Default: the tool's title and its arguments, cut. */
  readonly summarize?: (tool: McpTool, args: Record<string, unknown>) => string;
  /** Characters of text kept from one result. Default 50 000. */
  readonly maxText?: number;
  /** Images kept from one result (default 4), and the base64 characters allowed for one image (default 2 000 000) and for all. */
  readonly maxImages?: number;
  readonly maxImageChars?: number;
  readonly maxImagesChars?: number;
  /** Remove secrets from result text before the model sees it. */
  readonly redact?: (text: string) => string;
  /** Host policy checked inside every call: may this conversation use this source? A refusal never reaches the server. */
  readonly granted?: (conversationId: ConversationId) => boolean | Promise<boolean>;
  readonly signal?: AbortSignal;
}

export interface McpExtension {
  /** Install in the registry, then select per conversation: `conversation.configure({ extensions: { add: [extension] } })`. */
  readonly extension: Extension;
  /** Native tool name → upstream tool, for the exposed tools. */
  readonly tools: ReadonlyMap<string, McpTool>;
}

// Words joined by single separators: no `__`, so `<id>__<tool>` splits at its first `__` and two sources never share a name.
const ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const MAX_ID = 40, MAX_NAME = 64;
const MAX_TOOLS = 128;
/** Whether `id` is a valid `McpToolSource.id` (hosts can check configuration before building a source). */
export const isMcpSourceId = (id: unknown): id is string => typeof id === 'string' && id.length <= MAX_ID && ID.test(id);
export const MCP_EXTENSION_PREFIX = 'mcp.';
export const isMcpExtension = (extension: Extension) => extension.name.startsWith(MCP_EXTENSION_PREFIX);

/** Harness settings whose default selection is every installed extension except MCP ones (read at each resolution). */
export function withoutMcpByDefault(registry: RegistryReader): { readonly extensions: readonly Extension[] } {
  return { get extensions() { return registry.snapshot().installed().filter(extension => !isMcpExtension(extension)); } };
}

/** FNV-1a, for a short, stable suffix that keeps cut names distinct. */
const fnv = (text: string) => { let hash = 0x811c9dc5; for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; } return hash.toString(36); };

/** `<source>__<tool>`: unambiguous because a source id has no `__`; a name too long, or changed by sanitizing, gets a hash of the upstream name. */
export function mcpToolName(sourceId: string, tool: string): string {
  const clean = tool.replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `${sourceId}__${clean}`;
  if (name.length <= MAX_NAME && clean === tool) return name;
  const suffix = `_${fnv(tool)}`;
  return `${sourceId}__${clean.slice(0, MAX_NAME - sourceId.length - 2 - suffix.length)}${suffix}`;
}

/** Image types a result may carry to the model; anything else (or a MIME over 64 characters) is omitted with a note. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_MIME = 64;

/** A detached, deeply frozen copy of JSON-like discovery metadata: the client keeps its own objects and cannot change ours. */
function detach<T>(value: T): T {
  const copy = value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
  const freeze = (node: unknown) => { if (node && typeof node === 'object') { Object.freeze(node); for (const child of Object.values(node)) freeze(child); } };
  freeze(copy);
  return copy;
}

/** The fields this adapter reads, copied once at discovery, before any host policy sees them. */
function snapshot(tool: McpTool): McpTool {
  if (!tool || typeof tool.name !== 'string') throw new TypeError('An MCP tool must have a string name');
  const str = (value: unknown) => typeof value === 'string' ? value : undefined;
  const annotations = tool.annotations && typeof tool.annotations === 'object' ? detach(tool.annotations) : undefined;
  const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object' ? detach(tool.inputSchema) : undefined;
  const title = str(tool.title), description = str(tool.description);
  return Object.freeze({ name: String(tool.name), ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}),
    ...(inputSchema ? { inputSchema } : {}), ...(annotations ? { annotations } : {}) });
}

type Limits = { readonly maxText: number; readonly maxImages: number; readonly maxImageChars: number; readonly maxImagesChars: number };

/** Content blocks kept from one result, notes included; every further block is counted in one "[N blocks omitted]" note. */
const MAX_BLOCKS = 64;

function resultContent(result: McpCallResult, limits: Limits, redact: (text: string) => string): (TextContent | ImageContent)[] {
  const out: (TextContent | ImageContent)[] = [];
  // Text and images have their own budgets; the block count bounds the rest (two places stay free for the notes).
  let budget = limits.maxText, images = 0, imageChars = 0, omittedImages = 0, omittedBlocks = 0;
  const room = () => out.length < MAX_BLOCKS - 2;
  /** Keeps non-empty text within the budget; empty (or redacted-to-empty) text is dropped silently, text past the budget is counted. */
  const push = (text: string) => {
    if (!text) return;
    if (budget <= 0 || !room()) { omittedBlocks += 1; return; }
    const clean = redact(text);
    if (!clean) return;
    out.push({ type: 'text', text: clean.length > budget ? `${clean.slice(0, budget)}\n[truncated]` : clean });
    budget -= clean.length;
  };
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (!block || typeof block !== 'object') { omittedBlocks += 1; continue; }
    if (block.type === 'text') { if (typeof block['text'] === 'string') push(block['text'] as string); }
    else if (block.type === 'image') {
      const data = block['data'], mimeType = block['mimeType'];
      if (typeof data !== 'string' || typeof mimeType !== 'string' || mimeType.length > MAX_MIME || !IMAGE_TYPES.has(mimeType)
        || images >= limits.maxImages || data.length > limits.maxImageChars || imageChars + data.length > limits.maxImagesChars) { omittedImages += 1; continue; }
      if (!room()) { omittedBlocks += 1; continue; }
      images += 1; imageChars += data.length;
      out.push({ type: 'image', data, mimeType });
    } else push(`[${String(block.type).slice(0, 40)} content]`);
  }
  if (omittedImages) out.push({ type: 'text', text: `[${omittedImages} image${omittedImages === 1 ? '' : 's'} omitted: over the size or count limit, or not a PNG, JPEG, GIF or WebP image]` });
  if (omittedBlocks) out.push({ type: 'text', text: `[${omittedBlocks} block${omittedBlocks === 1 ? '' : 's'} omitted: over the text or block limit]` });
  if (!out.length && result.structuredContent !== undefined) push(JSON.stringify(result.structuredContent));
  if (!out.length) out.push({ type: 'text', text: result.isError ? 'The tool failed without a message.' : '(no content)' });
  return out;
}

/** List the source's tools once and build its extension. Call again (and reinstall) to pick up a changed tool list. */
export async function createMcpExtension(options: McpExtensionOptions): Promise<McpExtension> {
  const { source } = options;
  if (!isMcpSourceId(source.id)) throw new TypeError('An MCP source id must be up to 40 characters: lowercase words joined by single - or _');
  if (options.allow !== 'all' && !Array.isArray(options.allow)) throw new TypeError('allow must be a list of tool names or "all"');
  const limits: Limits = { maxText: options.maxText ?? 50_000, maxImages: options.maxImages ?? 4, maxImageChars: options.maxImageChars ?? 2_000_000, maxImagesChars: options.maxImagesChars ?? 6_000_000 };
  const redact = options.redact ?? (text => text);
  // Policy, dispatch and summaries read only these copies: a client mutating its own tool objects later changes nothing here.
  const listed = (await source.listTools(options.signal)).map(snapshot);
  const allowed = options.allow === 'all' ? listed : listed.filter(tool => (options.allow as readonly string[]).includes(tool.name));
  if (allowed.length > MAX_TOOLS) throw new RangeError(`An MCP source may expose at most ${MAX_TOOLS} tools`);
  const tools = new Map<string, McpTool>();
  const registrations: ToolRegistration[] = [];
  for (const upstream of allowed) {
    const name = mcpToolName(source.id, upstream.name);
    if (tools.has(name)) throw new Error(`Two MCP tools map to the same name: ${name}`);
    tools.set(name, upstream);
    const readOnly = options.readOnly?.(upstream) === true;
    const gate = options.approve ? options.approve(upstream) : !readOnly;
    const schema = upstream.inputSchema && typeof upstream.inputSchema === 'object' ? upstream.inputSchema : { type: 'object', properties: {} };
    const tool = defineTool({
      name,
      description: `${(upstream.description ?? upstream.title ?? upstream.name).slice(0, 1000)}\n(MCP: ${source.id}, tool ${upstream.name}${gate ? ', asks the person first' : ''})`,
      // The server's JSON Schema, passed through as is; arguments are checked against it before the call.
      parameters: Type.Unsafe<Record<string, unknown>>({ ...schema, type: 'object' }),
      // Replays only a host-declared read that does not ask: everything else may have changed something upstream.
      replay: readOnly && !gate ? 'safe' : 'unsafe',
      execute: async (args, api, context) => {
        if (options.granted && !await options.granted(api.conversationId)) {
          return { isError: true, content: [{ type: 'text' as const, text: `This conversation may not use ${source.id}. Ask the person to connect it here first.` }] };
        }
        // A stop that arrived while the host decided (or while anything before this awaited) is native cancellation: no dispatch.
        context.abortSignal?.throwIfAborted();
        let result: McpCallResult;
        try {
          result = await source.callTool(upstream.name, args as Record<string, unknown>, { conversationId: api.conversationId, ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
        } catch (error) {
          if (context.abortSignal?.aborted) throw error; // a stop stays a stop
          const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1000);
          return { isError: true, content: [{ type: 'text' as const, text: `The ${source.id} call failed: ${message}` }] };
        }
        return { isError: result.isError === true, content: resultContent(result, limits, redact) };
      },
    }) as ToolRegistration;
    const summarize = (args: Record<string, unknown>) => (options.summarize?.(upstream, args) ?? `${upstream.annotations?.title ?? upstream.title ?? upstream.name} (${source.id}): ${JSON.stringify(args)}`).slice(0, 500);
    const approveCall = options.approveCall;
    registrations.push(gate ? requireApproval(tool, { summarize: args => summarize(args as Record<string, unknown>),
      ...(approveCall ? { when: (args: unknown) => { try { return approveCall(upstream, args as Record<string, unknown>) !== false; } catch { return true; } } } : {}) }) as ToolRegistration : tool);
  }
  return { extension: defineExtension({ name: `${MCP_EXTENSION_PREFIX}${source.id}`, tools: registrations }), tools };
}
