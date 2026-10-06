// Browser side of the studio: the pi-chat registry item (owned Tailwind source) over the remote chat transport. No Pi runtime is bundled.
// One standard agent: the page lists scenarios in the empty chat, offers the variants (infrastructure) in the header and opens
// artifacts, files and the Workspace tabs in the panel beside the chat.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelRightOpenIcon } from 'lucide-react';
import { PiChat, artifactKey } from '../../registry/pi-chat/pi-chat.tsx';
import { AmbientChat } from '../../registry/pi-ambient/ambient.tsx';
import { ArtifactWorkspace } from '../../registry/pi-workspace/workspace.tsx';
import { ViewerFrame, ViewerWindowProvider } from '../../registry/viewers/viewer-frame.tsx';
import { useChat } from '../shared/use-chat.mjs';
import { WorkspaceTabs } from './panels.jsx';
import { ArtifactPanel, useArtifactVersions, useTurn, useTyped } from './artifact-panel.jsx';
import { FileViewer } from './file-viewer.jsx';
import { useScenarioRun } from './scenarios-ui.jsx';
import { setStudioContext, takeLink } from './share-link.mjs';
import { savedResource } from './saved-resource.mjs';

const { token, identity } = window.__STUDIO__;
// Every request names the variant the page is showing; the server keeps one workspace and one resource store per variant.
let shown;
const authorized = request => {
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (shown) headers.set('x-studio-variant', shown);
  return fetch(new Request(request, { headers }));
};
const api = async (path, init) => { const response = await authorized(new Request(new URL(path, location.href), init)); if (!response.ok) throw new Error(`${path}: ${response.status}`); return response.json(); };
const remember = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* optional convenience */ } };
const recall = key => { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { return null; } };

/** The History list: the variant's conversations with a title (named, or the first message), a preview of the last message and when each last had activity. */
function useConversations(variantId, conversationId) {
  const [items, setItems] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!variantId) return;
    let off = false;
    const load = () => api(`/api/variants/${variantId}/conversations`).then(result => { if (!off) setItems(result.conversations); }).catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => { off = true; clearInterval(timer); };
  }, [variantId, conversationId, version]);
  return { items, reload: () => setVersion(value => value + 1) };
}
const conversationItem = item => ({ id: String(item.id), title: item.title ?? undefined, updatedAt: item.updatedAt ?? undefined, lastMessage: item.lastMessage, archived: item.archived });
/** One operation of the History list on the server (`@boring/agent/conversations` behind /api/variants/:id/conversations). */
const conversationOp = (variantId, op, body) => api(`/api/variants/${variantId}/conversations?op=${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Host commands the `/` menu offers next to the agent's skills.
// `/reload` exists only for a self-evolving agent: the same reload as the agent's tool, run by the host for the person.
const HOST_COMMANDS = {
  new: { description: 'Start a new conversation', run: host => host.newConversation() },
  clear: { description: 'Clear the message box', run: (_host, { setText }) => setText('') },
  reload: { description: 'Apply the agent\'s own .agent/ instructions, skills and tools', when: variant => variant.selfEvolving, run: (host, { setText }) => { setText(''); return host.reload(); } },
};

/** The PiChat composer props for one variant: the `/` menu, mentions and attachments (when it has a workspace), model and effort. */
function chatProps(variant, chat, host) {
  const props = {
    slash: { skills: variant.skills, commands: Object.entries(HOST_COMMANDS).filter(([, command]) => !command.when || command.when(variant))
      .map(([name, command]) => ({ name, description: command.description, run: api => command.run(host, api) })) },
  };
  if (variant.capabilities.includes('workspace')) {
    props.mentions = { search: async (query, signal) => (await api(`/api/search?q=${encodeURIComponent(query)}`, { signal })).results };
    props.attachments = { upload: files => Promise.all(files.map(async file => {
      const response = await authorized(new Request(new URL(`/api/upload?name=${encodeURIComponent(file.name)}`, location.href), { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } }));
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).reason ?? `Upload failed (${response.status})`);
      return response.json();
    })) };
  }
  const refuse = async change => { const result = await chat.configure(change); if (result.kind === 'refused') throw new Error(result.reason ?? 'The change was refused.'); };
  props.model = { options: variant.chat.models, change: model => refuse({ model }) };
  props.effort = { options: variant.chat.efforts, change: level => refuse({ thinkingLevel: level }) };
  return props;
}

/** The Workspace tool view inside the panel, under the standard viewer bar. */
function WorkspacePanel({ variant, tab, onTab, conversation, openPath, onOpenFile, onClose }) {
  return <ViewerFrame title="Workspace" subtitle={<span>Files the agent can read and change{variant.id === 'local' ? '' : ` \u00b7 ${variant.title}`}</span>} testId="demo-panel" titleTestId="demo-panel-title" onClose={onClose}>
    <div className="studio-panel min-h-0 flex-1 overflow-auto p-3" data-panel={tab} aria-label="Workspace panel">
      <WorkspaceTabs variant={variant} tab={tab} onTab={onTab} api={api} conversation={conversation} openPath={openPath} onOpenFile={onOpenFile} />
    </div>
  </ViewerFrame>;
}

function App() {
  const [studio, setStudio] = useState(null);
  const refresh = () => api('/api/studio').then(setStudio);
  // A shared link names the variant (and conversation) to open; it wins over what this tab last showed.
  const [selected, setSelected] = useState(() => {
    const variant = takeLink('variant'), conversation = takeLink('conversation');
    if (variant) return { variant, ...(conversation ? { conversation: Number(conversation) } : {}) };
    return recall('studio.selected');
  });
  // A shared link may also name an artifact (and version) of that conversation; it opens once the conversation has loaded.
  const [linked, setLinked] = useState(() => { const id = takeLink('artifact'); return id ? { id, version: takeLink('version') ?? 'latest' } : null; });
  const [mode, setMode] = useState('developer');
  // The panel's content: an artifact { conversation, descriptor, follow }, a workspace file { kind: 'file', path } (a shared link may name
  // one) or the Workspace tabs { kind: 'workspace', tab }. It survives a reload and belongs to its conversation.
  const [opened, setOpened] = useState(() => { const path = takeLink('file'); return path ? { kind: 'file', path } : recall('studio.artifact'); });
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => { remember('studio.artifact', opened?.kind === 'file' ? null : opened); }, [opened]);
  useEffect(() => { refresh().catch(() => setStudio({ variants: [], scenarios: [] })); }, []);
  useEffect(() => { remember('studio.selected', selected); }, [selected]);
  const variants = studio?.variants ?? [];
  const live = variants.filter(candidate => candidate.available);
  const variant = live.find(candidate => candidate.id === selected?.variant) ?? live[0];
  shown = variant?.id;
  // An open workspace file or tool view belongs to the variant it was opened in.
  const fileVariant = useRef(undefined);
  useEffect(() => {
    if (fileVariant.current !== undefined && fileVariant.current !== variant?.id) setOpened(current => current?.kind === 'file' || current?.kind === 'workspace' ? null : current);
    if (variant) fileVariant.current = variant.id;
  }, [variant?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const conversationId = variant ? (variant.conversations.includes(selected?.conversation) ? selected.conversation : variant.conversations.at(-1)) : undefined;
  const chat = useChat(conversationId, authorized, identity);
  setStudioContext({ variant: variant?.id, conversation: conversationId });
  async function newConversation() {
    const { conversationId: created } = await conversationOp(variant.id, 'create', {});
    await refresh();
    setSelected({ variant: variant.id, conversation: created });
  }
  // What the person's last `/reload` reported, shown above the chat until dismissed.
  const [reloaded, setReloaded] = useState(null);
  const reload = async () => { const result = await api('/api/reload', { method: 'POST' }); setReloaded(result.text); };
  const composer = useMemo(() => variant && chat.status === 'ready' ? chatProps(variant, chat, { newConversation, reload }) : {}, [variant, chat]); // eslint-disable-line
  const detect = useMemo(() => variant && chat.status === 'ready' ? savedResource(variant) : undefined, [variant, chat.status]); // eslint-disable-line
  const versions = useArtifactVersions(chat.status === 'ready' ? chat.controller : undefined, detect);
  const active = opened && opened.kind !== 'file' && opened.kind !== 'workspace' && opened.conversation === conversationId ? opened : null;
  const activeFile = opened?.kind === 'file' ? opened : null;
  const activeWorkspace = opened?.kind === 'workspace' ? opened : null;
  const panelOpen = Boolean(active || activeFile || activeWorkspace);
  const conversationItems = useConversations(variant?.id, conversationId);
  const turn = useTurn(chat.status === 'ready' ? chat.controller : undefined);
  const typed = useTyped(chat.status === 'ready' ? chat.controller : undefined);
  const seen = useRef(new Map());
  const closedInTurn = useRef(new Map());
  const close = () => { closedInTurn.current.set(conversationId, turn); setOpened(null); setFullscreen(false); };
  // Claude's behaviour: when the agent makes an artifact (or a new version of one) the panel opens on it, unless the person closed it
  // during this turn. What the conversation already held when it loaded does not count, and a phone keeps to the card.
  useEffect(() => {
    if (chat.status !== 'ready') return;
    const keys = versions.map(version => `${artifactKey(version)}:${version.revision}`);
    const known = seen.current.get(conversationId);
    if (!known) { seen.current.set(conversationId, new Set(keys)); return; }
    const fresh = versions.filter(version => !known.has(`${artifactKey(version)}:${version.revision}`));
    for (const key of keys) known.add(key);
    if (!fresh.length || closedInTurn.current.get(conversationId) === turn || window.matchMedia('(max-width: 900px)').matches) return;
    setOpened({ conversation: conversationId, descriptor: fresh.at(-1), follow: true });
  }, [versions, chat.status, conversationId, turn]);
  // The versions of one file that the conversation presented or saved, newest first.
  const newestOf = key => versions.filter(version => artifactKey(version) === key).reverse();
  const artifacts = useMemo(() => ({
    open: descriptor => {
      setOpened({ conversation: conversationId, descriptor, follow: descriptor.revision === newestOf(artifactKey(descriptor))[0]?.revision });
    },
    isOpen: descriptor => Boolean(active && artifactKey(active.descriptor) === artifactKey(descriptor) && (active.follow ? descriptor.revision === newestOf(artifactKey(descriptor))[0]?.revision : descriptor.revision === active.descriptor.revision)),
    ...(detect ? { detect } : {}),
  }), [conversationId, active, versions, detect]); // eslint-disable-line
  useEffect(() => {
    if (!linked || chat.status !== 'ready') return;
    const known = newestOf(linked.id);
    // A link to an older version may name a revision the conversation never presented (the file's history has it).
    const found = linked.version === 'latest' ? known[0] : known.find(version => version.revision === linked.version) ?? (known[0] ? { ...known[0], revision: linked.version } : undefined);
    if (!found) return;
    setOpened({ conversation: conversationId, descriptor: found, follow: linked.version === 'latest' });
    setLinked(null);
  }, [linked, chat.status, versions, conversationId]);

  const scenarioRun = useScenarioRun({ storageKey: 'studio.scenario', scenarios: studio?.scenarios ?? [], variants, variant, controller: chat.status === 'ready' ? chat.controller : undefined, conversationId, typed,
    seed: item => api(`/api/scenarios/${item.id}/seed`, { method: 'POST' }).catch(() => {}), fixtureUrl: (item, step) => `/api/scenarios/${item.id}/fixture/${step.index}`,
    openPanel: item => { if (item.panel && variant) setOpened({ kind: 'workspace', tab: item.panel }); } });
  if (!studio) return <p className="studio-loading">Loading…</p>;
  if (!variant) return <p className="studio-loading" role="alert">The studio server is unreachable, or no variant is available.</p>;
  const known = active ? newestOf(artifactKey(active.descriptor)) : [];
  // Every change is the server's; the list reloads after it, and a fork or a deleted open conversation changes what is open.
  const changed = async () => { conversationItems.reload(); await refresh(); };
  const conversations = conversationItems.items ? { items: conversationItems.items.map(conversationItem),
    activeId: String(conversationId), onSelect: id => setSelected({ variant: variant.id, conversation: Number(id) }), onNew: () => { newConversation().catch(() => {}); },
    search: async (query, { archived }, signal) => (await api(`/api/variants/${variant.id}/conversations?q=${encodeURIComponent(query)}${archived ? '&archived=1' : ''}`, { signal })).conversations.map(conversationItem),
    rename: async (id, title) => { await conversationOp(variant.id, 'rename', { conversationId: Number(id), title }); await changed(); },
    archive: async (id, archived) => { await conversationOp(variant.id, 'archive', { conversationId: Number(id), archived }); await changed(); },
    remove: async id => { await conversationOp(variant.id, 'delete', { conversationId: Number(id) }); await changed(); },
    fork: async at => {
      const { conversationId: forked } = await conversationOp(variant.id, 'fork', { conversationId: conversationId, at: Number(at) });
      await changed();
      setSelected({ variant: variant.id, conversation: forked });
    } } : undefined;
  const openFile = path => setOpened({ kind: 'file', path });
  const openWorkspace = () => setOpened({ kind: 'workspace', tab: 'files' });
  const shared = chat.status === 'ready' ? { controller: chat.controller, title: 'Assistant', mode, actions: chat.actions, artifacts, conversations, ...composer,
    ...(composer.mentions ? { mentions: { ...composer.mentions, open: path => openFile(`/workspace/${path}`) } } : {}) } : null;
  // The same controller drives both surfaces: when the divider is dragged far enough the chat floats (AmbientChat) and docks back (PiChat) with its transcript, draft and queue.
  const floatingChat = dock => shared && <AmbientChat key={conversationId} {...shared} variant="surface" defaultState="expanded" onDock={dock} />;
  const chatCard = chat.status === 'ready'
    ? <PiChat key={conversationId} {...shared}
        emptyState={scenarioRun.emptyState} decisions={scenarioRun.decisions}
        controls={!panelOpen ? <button type="button" className="studio-panel-toggle" data-testid="studio-panel-open" onClick={openWorkspace}><PanelRightOpenIcon size={16} aria-hidden="true" />Workspace</button> : undefined} />
    : <p className="studio-loading" role="status">{chat.status === 'offline' ? 'Server unreachable. Retrying…' : 'Connecting…'}</p>;
  return <div className="studio" data-variant={variant.id} data-viewer={panelOpen ? (active ? 'artifact' : activeWorkspace ? 'workspace' : 'file') : undefined}>
    <header className="studio-bar">
      <h1>Boring studio</h1>
      <label className="studio-variant">Environment
        <select data-testid="variant-select" aria-label="Environment" value={variant.id} onChange={event => setSelected({ variant: event.target.value })}>
          {variants.map(candidate => <option key={candidate.id} value={candidate.id} disabled={!candidate.available} title={candidate.available ? candidate.description : candidate.reason}>{candidate.available ? candidate.title : `${candidate.title} (unavailable)`}</option>)}
        </select>
      </label>
      <label className="studio-mode" title="Show every tool call with its arguments and result"><input type="checkbox" checked={mode === 'developer'} onChange={event => setMode(event.target.checked ? 'developer' : 'expert')} /> Tool calls</label>
    </header>
    <main className="studio-main" data-testid="studio-main" data-conversation={conversationId}>
      <ArtifactWorkspace open={panelOpen} onClose={close} fullscreen={fullscreen} onFullscreenChange={setFullscreen} storageKey="studio.panel-width" sheetBelow={901} floatBelow={320}
        chat={layout => layout.floating ? floatingChat(layout.dock) : <div className="studio-chat">
          {reloaded && <div className="studio-notice" role="status" data-testid="reload-summary">
            <pre>{reloaded}</pre>
            <button type="button" aria-label="Dismiss" data-testid="reload-summary-dismiss" onClick={() => setReloaded(null)}>×</button>
          </div>}
          {chatCard}</div>}
        panel={win => <ViewerWindowProvider value={{ fullscreen: win.fullscreen, onFullscreenChange: win.onFullscreenChange, onFloatChat: win.floatChat }}>
          <div className="studio-artifact" data-testid="viewer-panel" data-kind={active ? 'artifact' : activeWorkspace ? 'workspace' : 'file'}>
            {active
              ? <ArtifactPanel key={artifactKey(active.descriptor)} active={active} versions={known} api={api} authorized={authorized} identity={identity} shareTarget={{ variant: variant.id, conversation: conversationId }}
                  onSelect={value => setOpened({ conversation: conversationId, follow: value === 'latest', descriptor: value === 'latest' ? (known[0] ?? active.descriptor) : { ...active.descriptor, revision: value } })}
                  onClose={win.close} />
              : activeWorkspace ? <WorkspacePanel key={variant.id} variant={variant} tab={activeWorkspace.tab} onTab={tab => setOpened({ kind: 'workspace', tab })} conversation={conversationId} onOpenFile={openFile} onClose={win.close} />
              : activeFile && <FileViewer key={activeFile.path} path={activeFile.path} agentId={variant.id} api={api} authorized={authorized} identity={identity} onClose={win.close}
                  onBack={() => setOpened({ kind: 'workspace', tab: 'files' })} backLabel="Files" />}
          </div></ViewerWindowProvider>} />
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
