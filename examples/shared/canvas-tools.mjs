// Canvas tools of the standard agent: tools over one tldraw document, the workspace file `board.tldraw`, which the person sees and
// edits in the panel beside the chat. Records are built and validated with the native tldraw schema. The file follows the same rule
// as Pi's own file tools behind the guard (@boring/agent/file-guard): a change needs the conversation to have read the saved revision
// (`read_canvas` records it), is published conditionally on exactly that revision, and a stale one is refused instead of overwriting.
// No Node-only imports.
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { baselineKey, lastReadRevision, recordRevision } from '@boring/agent/file-guard';
import { asWorkspaceResolver, workspaceFor } from '@boring/agent/workspaces';
import { DocumentRecordType, PageRecordType, TLDOCUMENT_ID, createBindingId, createShapeId, createTLSchema, toRichText } from '@tldraw/tlschema';
import { getIndexAbove } from '@tldraw/utils';

// The value of `canvasMediaType` in @boring/ui/canvas. That module loads the browser editor runtime (@tldraw/editor), which
// keeps a Node process alive, so the server names the media type here and the panel uses the library constant.
export const canvasMediaType = 'application/vnd.tldraw+json';
const COLORS = ['black', 'grey', 'blue', 'light-blue', 'green', 'light-green', 'yellow', 'orange', 'red', 'light-red', 'violet', 'light-violet'];
// The only shape and binding types the library canvas controller accepts for publication.
const SUPPORTED = new Set(['arrow', 'draw', 'frame', 'geo', 'group', 'highlight', 'line', 'note', 'text']);
const schema = createTLSchema();
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const slug = id => String(id).replace(/^shape:/, '').trim();
const round = value => Math.round(value * 10) / 10;

/** Plain text of a tldraw rich text document, one line per paragraph. */
function plain(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  const parts = (node.content ?? []).map(plain);
  return node.type === 'doc' ? parts.join('\n') : parts.join('');
}
const validated = (type, record) => schema.types[type].validate(schema.types[type].create(record));

function emptyDocument() {
  const records = [DocumentRecordType.create({ id: TLDOCUMENT_ID, name: 'Fictional board' }), PageRecordType.create({ id: PageRecordType.createId('page'), name: 'Page 1', index: 'a1' })];
  return { schema: schema.serialize(), store: Object.fromEntries(records.map(record => [record.id, record])) };
}
const shapesOf = document => Object.values(document.store).filter(record => record.typeName === 'shape');
const bindingsOf = document => Object.values(document.store).filter(record => record.typeName === 'binding');
const pageOf = document => Object.values(document.store).filter(record => record.typeName === 'page').sort((a, b) => a.index < b.index ? -1 : 1)[0];

/** The compact description of the canvas an agent reads: one line of facts per shape. */
function describe(document) {
  const ends = new Map();
  for (const binding of bindingsOf(document)) if (binding.type === 'arrow') (ends.get(binding.fromId) ?? ends.set(binding.fromId, {}).get(binding.fromId))[binding.props.terminal] = slug(binding.toId);
  return shapesOf(document).map(shape => {
    const text = plain(shape.props.richText), item = { id: slug(shape.id), type: shape.type === 'geo' ? shape.props.geo : shape.type, x: round(shape.x), y: round(shape.y) };
    if (text) item.text = text;
    if (typeof shape.props.w === 'number') item.w = round(shape.props.w);
    if (typeof shape.props.h === 'number') item.h = round(shape.props.h + (shape.props.growY ?? 0));
    if (shape.type === 'arrow') { item.from = ends.get(shape.id)?.start ?? null; item.to = ends.get(shape.id)?.end ?? null; }
    return item;
  });
}

/**
 * The three canvas tools over one workspace file. `workspace` is the workspace of each call, resolved like Pi's env
 * (`@boring/agent/workspaces`: a resolver, or one binding `{ files, root, access? }` whose `files` is the workspace provider);
 * `path` the file, `access` the agent's principal (default: the binding's) and `namespace` makes publication operation ids unique
 * to the host. `files` alone is the one-workspace shorthand; neither: the workspace attached to the call's env (`withWorkspace`).
 */
export function createCanvasTools({ files, workspace = files ? { files, root: '/' } : undefined, path = 'board.tldraw', access, namespace = 'canvas-v1' } = {}) {
  const resolver = asWorkspaceResolver(workspace);
  /** The call's workspace: its provider, the agent's access, the file's locator and the conversation's baseline key. */
  async function bind(api, context) {
    const resolved = await workspaceFor(resolver, api, context);
    if (resolved.refused) return { refused: { kind: 'denied', reason: resolved.refused } };
    const { binding } = resolved, granted = access ?? binding.access;
    if (!granted) return { refused: { kind: 'denied', reason: 'The host gave no access for this workspace' } };
    return { files: binding.files, access: granted, key: baselineKey(binding, path), target: { resource: { providerId: binding.files.providerId, path }, view: { kind: 'published' } } };
  }
  async function load({ files, access, target }) {
    const read = await files.read({ target, revision: { kind: 'latest' } }, access);
    if (read.kind === 'missing') return { kind: 'missing' };
    if (read.kind !== 'available') return { kind: 'failed', result: read };
    try {
      return { kind: 'available', revision: read.snapshot.ref.revision, document: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.snapshot.bytes)) };
    } catch { return { kind: 'failed', result: { kind: 'unavailable', reason: 'The saved board is not a tldraw canvas' } }; }
  }
  /** Load for a change: the conversation must have read the saved canvas and it must be unchanged since; anything else is reported, never overwritten. */
  async function loadForChange(ws, api, context) {
    const current = await load(ws);
    if (current.kind === 'failed') return { refused: current.result };
    if (current.kind === 'missing') return { document: emptyDocument(), revision: null };
    const known = await lastReadRevision(api, ws.key, context);
    if (known === undefined) return { refused: { kind: 'conflict', reason: 'You have not read the canvas yet. Call read_canvas first.' } };
    if (known !== current.revision) return { refused: { kind: 'conflict', reason: 'The canvas changed since you last read it. Call read_canvas again and redo the change.' } };
    return current;
  }
  async function publish(ws, api, context, document, revision) {
    const { files, access, target } = ws;
    const unsupported = [...shapesOf(document), ...bindingsOf(document)].find(record => !SUPPORTED.has(record.type));
    if (unsupported) return { kind: 'denied', reason: `The canvas contains an unsupported ${unsupported.type} record` };
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    const result = await files.publication.publish({ operationId: JSON.stringify([namespace, api.taskId]), atomicity: 'all-or-nothing',
      changes: [revision === null ? { kind: 'create', target, expected: { kind: 'absent' }, bytes, mediaType: canvasMediaType }
        : { kind: 'replace', target: { ...target, revision }, bytes, mediaType: canvasMediaType }] }, access);
    if (result.kind !== 'committed') return result;
    const saved = await load(ws);
    if (saved.kind === 'available') await recordRevision(api, ws.key, saved.revision, context);
    return { kind: 'saved', revision: saved.kind === 'available' ? saved.revision : undefined, shapes: describe(document) };
  }

  const readCanvas = defineTool({
    name: 'read_canvas', description: 'Read the saved canvas: a compact list of shapes (id, type, text, x, y, w, h; arrows have from and to shape ids). Read it before you change it. Reports missing when nothing is saved yet.',
    parameters: Type.Object({}, { additionalProperties: false }), replay: 'safe',
    execute: async (_args, api, context) => {
      const ws = await bind(api, context);
      if (ws.refused) return reply(ws.refused);
      const current = await load(ws);
      if (current.kind === 'available') await recordRevision(api, ws.key, current.revision, context);
      return reply(current.kind === 'available' ? { kind: 'available', shapes: describe(current.document) } : current.kind === 'missing' ? { kind: 'missing', shapes: [] } : current.result);
    },
  });

  const addShapes = defineTool({
    name: 'add_canvas_shapes',
    description: 'Add shapes and arrows to the canvas you read. Coordinates are pixels, x to the right and y downwards; x,y is the top-left corner of a shape. Arrows connect two shape ids (existing or added in the same call) and follow the shapes when they move.',
    parameters: Type.Object({
      shapes: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,39}$', description: 'A new short id of your choice, such as "plan" or "box-2".' }),
        kind: Type.Union([Type.Literal('rectangle'), Type.Literal('ellipse'), Type.Literal('text')], { description: 'rectangle or ellipse: a labelled box. text: a free text note without a border.' }),
        text: Type.String(),
        x: Type.Number(), y: Type.Number(),
        w: Type.Optional(Type.Number({ minimum: 20, maximum: 2000, description: 'Width, default 180.' })),
        h: Type.Optional(Type.Number({ minimum: 20, maximum: 2000, description: 'Height, default 90 (ignored for text).' })),
        color: Type.Optional(Type.Union(COLORS.map(color => Type.Literal(color)))),
      }, { additionalProperties: false }))),
      arrows: Type.Optional(Type.Array(Type.Object({
        from: Type.String({ minLength: 1, description: 'Id of the shape the arrow starts at.' }),
        to: Type.String({ minLength: 1, description: 'Id of the shape the arrow points to.' }),
        text: Type.Optional(Type.String({ description: 'Optional label on the arrow.' })),
      }, { additionalProperties: false }))),
    }, { additionalProperties: false }),
    replay: 'unsafe',
    execute: async (args, api, context) => {
      const shapes = args.shapes ?? [], arrows = args.arrows ?? [];
      if (shapes.length + arrows.length === 0) return reply({ kind: 'denied', reason: 'Nothing to add' });
      const ws = await bind(api, context);
      if (ws.refused) return reply(ws.refused);
      const current = await loadForChange(ws, api, context);
      if (current.refused) return reply(current.refused);
      const { document } = current, page = pageOf(document);
      if (!page) return reply({ kind: 'denied', reason: 'The canvas has no page' });
      let index = shapesOf(document).filter(shape => shape.parentId === page.id).map(shape => shape.index).sort().at(-1);
      const next = () => (index = getIndexAbove(index));
      const put = (type, record) => { const valid = validated(type, record); document.store[valid.id] = valid; return valid; };
      try {
        for (const shape of shapes) {
          const id = createShapeId(shape.id);
          if (document.store[id]) return reply({ kind: 'denied', reason: `Shape id "${shape.id}" already exists; choose another id` });
          const common = { id, parentId: page.id, index: next(), x: shape.x, y: shape.y }, color = shape.color ?? 'black', richText = toRichText(shape.text);
          if (shape.kind === 'text') put('shape', { ...common, type: 'text', props: { color, size: 'm', font: 'sans', textAlign: 'start', w: shape.w ?? 180, richText, scale: 1, autoSize: shape.w === undefined } });
          else put('shape', { ...common, type: 'geo', props: { geo: shape.kind, dash: 'solid', url: '', w: shape.w ?? 180, h: shape.h ?? 90, growY: 0, scale: 1, flipX: false, flipY: false,
            labelColor: 'black', color, fill: 'semi', size: 'm', font: 'sans', align: 'middle', verticalAlign: 'middle', richText } });
        }
        for (const arrow of arrows) {
          const ends = [arrow.from, arrow.to].map(end => document.store[createShapeId(slug(end))]);
          const missing = [arrow.from, arrow.to].find((_, at) => !ends[at] || ends[at].type === 'arrow');
          if (missing !== undefined) return reply({ kind: 'denied', reason: `Arrow end "${missing}" is not a shape on the canvas` });
          const name = `arrow-${slug(arrow.from)}-${slug(arrow.to)}`;
          let id = createShapeId(name);
          for (let copy = 2; document.store[id]; copy++) id = createShapeId(`${name}-${copy}`);
          // The editor routes a bound arrow from its bindings; the stored points are the two shape centres.
          const [start, end] = ends.map(shape => ({ x: shape.x + (shape.props.w ?? 0) / 2, y: shape.y + (shape.props.h ?? 0) / 2 }));
          put('shape', { id, type: 'arrow', parentId: page.id, index: next(), x: 0, y: 0, props: { kind: 'arc', elbowMidPoint: 0.5, dash: 'solid', size: 'm', fill: 'none', color: 'black', labelColor: 'black',
            bend: 0, start, end, arrowheadStart: 'none', arrowheadEnd: 'arrow', richText: toRichText(arrow.text ?? ''), labelPosition: 0.5, font: 'sans', scale: 1 } });
          ['start', 'end'].forEach((terminal, at) => put('binding', { id: createBindingId(`${slug(id)}-${terminal}`), type: 'arrow', fromId: id, toId: ends[at].id,
            props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } }));
        }
      } catch (error) { return reply({ kind: 'denied', reason: `Invalid canvas record: ${error?.message ?? error}` }); }
      return reply(await publish(ws, api, context, document, current.revision));
    },
  });

  const removeShapes = defineTool({
    name: 'remove_canvas_shapes', description: 'Remove shapes by id from the canvas you read. Arrows attached to a removed shape are removed too.',
    parameters: Type.Object({ ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }, { additionalProperties: false }),
    replay: 'unsafe',
    execute: async (args, api, context) => {
      const ws = await bind(api, context);
      if (ws.refused) return reply(ws.refused);
      const current = await loadForChange(ws, api, context);
      if (current.refused) return reply(current.refused);
      if (current.revision === null) return reply({ kind: 'denied', reason: 'No canvas is saved' });
      const { document } = current, doomed = new Set(args.ids.map(id => createShapeId(slug(id))));
      const unknown = args.ids.find(id => document.store[createShapeId(slug(id))]?.typeName !== 'shape');
      if (unknown !== undefined) return reply({ kind: 'denied', reason: `Shape "${unknown}" is not on the canvas` });
      for (const binding of bindingsOf(document)) if (doomed.has(binding.toId)) doomed.add(binding.fromId);
      // Children of a removed frame or group go with it.
      for (let grew = true; grew;) { grew = false; for (const shape of shapesOf(document)) if (doomed.has(shape.parentId) && !doomed.has(shape.id)) { doomed.add(shape.id); grew = true; } }
      for (const binding of bindingsOf(document)) if (doomed.has(binding.fromId) || doomed.has(binding.toId)) delete document.store[binding.id];
      for (const id of doomed) delete document.store[id];
      return reply(await publish(ws, api, context, document, current.revision));
    },
  });

  return [readCanvas, addShapes, removeShapes];
}
