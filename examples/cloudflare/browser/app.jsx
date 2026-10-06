// Browser side of the Cloudflare recipe: the pi-chat registry item and the artifact panel over the remote chat transport, with the SAME
// scenario list as the studio (scenarios/*.mjs described at build time into scenarios.json). No Pi runtime is bundled. The access token is
// entered once, kept in sessionStorage (when allowed) and sent as a bearer header.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotebookTextIcon } from 'lucide-react';
import { PiChat, artifactKey } from '../../../registry/pi-chat/pi-chat.tsx';
import { ArtifactWorkspace } from '../../../registry/pi-workspace/workspace.tsx';
import { ViewerWindowProvider } from '../../../registry/viewers/viewer-frame.tsx';
import { useChat } from '../../shared/use-chat.mjs';
import { ArtifactPanel, useArtifactVersions, useTurn, useTyped } from '../../studio/artifact-panel.jsx';
import { useScenarioRun } from '../../studio/scenarios-ui.jsx';
import { savedResource } from '../../studio/saved-resource.mjs';
import { setStudioContext, takeLink } from '../../studio/share-link.mjs';

const KEY = 'recipe.token';
const readStored = () => { try { return sessionStorage.getItem(KEY) ?? ''; } catch { return ''; } };
const store = token => { try { sessionStorage.setItem(KEY, token); } catch { /* optional convenience */ } };

/** The token may arrive in the URL fragment (`#token=...`): take it and remove it from the address bar. It is never a query parameter. */
function takeFragmentToken() {
  const found = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (!found) return '';
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(found[1]);
}

function Gate({ onToken, message }) {
  const [value, setValue] = useState('');
  return <form className="cf-gate" data-testid="token-form" onSubmit={event => { event.preventDefault(); if (value.trim()) onToken(value.trim()); }}>
    <h1>Assistant on Cloudflare</h1>
    <p>Enter the access token for this deployment. It stays in this tab only.</p>
    <input type="password" autoComplete="off" aria-label="Access token" data-testid="token-input" value={value} onChange={event => setValue(event.target.value)} />
    <button type="submit" data-testid="token-submit">Open</button>
    {message && <p role="alert" className="cf-error" data-testid="token-error">{message}</p>}
  </form>;
}

function Workspace({ token, onRejected }) {
  const authorized = useMemo(() => request => { const headers = new Headers(request.headers); headers.set('authorization', `Bearer ${token}`); return fetch(new Request(request, { headers })); }, [token]);
  const api = async (path, init) => {
    const response = await authorized(new Request(new URL(path, location.href), init));
    if (response.status === 401) { onRejected(); throw new Error('rejected'); }
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  };
  const [agent, setAgent] = useState(null);
  const [scenarios, setScenarios] = useState([]);
  const [items, setItems] = useState(null);
  // A shared link names the conversation (and an artifact version) to open; it wins over what this tab last showed.
  const [selected, setSelected] = useState(() => { const linked = Number(takeLink('conversation')); if (linked) return linked; try { return Number(sessionStorage.getItem('recipe.conversation')) || undefined; } catch { return undefined; } });
  const [linked, setLinked] = useState(() => { const id = takeLink('artifact'); return id ? { id, version: takeLink('version') ?? 'latest' } : null; });
  // The open artifact survives a reload, as in the studio.
  const [opened, setOpened] = useState(() => { try { return JSON.parse(sessionStorage.getItem('recipe.artifact') ?? 'null'); } catch { return null; } });
  useEffect(() => { try { sessionStorage.setItem('recipe.artifact', JSON.stringify(opened)); } catch { /* optional convenience */ } }, [opened]);
  const [fullscreen, setFullscreen] = useState(false);
  const reload = () => api('/api/conversations').then(result => setItems(result.conversations)).catch(() => {});
  useEffect(() => {
    api('/api/agent').then(setAgent).catch(() => {});
    // The scenario descriptions were written next to the page at build time: the same files the studio lists.
    fetch('/scenarios.json').then(response => response.json()).then(setScenarios).catch(() => {});
    reload();
    const timer = setInterval(reload, 4000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const conversationId = items ? (items.some(item => item.id === selected) ? selected : items.at(-1)?.id) : undefined;
  useEffect(() => { try { if (conversationId !== undefined) sessionStorage.setItem('recipe.conversation', String(conversationId)); } catch { /* optional */ } }, [conversationId]);
  const chat = useChat(agent ? conversationId : undefined, authorized, agent?.identity);
  // The variant as the page and the scenario list see it: what this deployment gives the one standard agent.
  const variant = useMemo(() => agent && { ...agent.variant, notes: agent.notes, canvas: undefined }, [agent]);
  const detect = useMemo(() => variant && chat.status === 'ready' ? savedResource(variant) : undefined, [variant, chat.status]);
  const versions = useArtifactVersions(chat.status === 'ready' ? chat.controller : undefined, detect);
  const turn = useTurn(chat.status === 'ready' ? chat.controller : undefined);
  const typed = useTyped(chat.status === 'ready' ? chat.controller : undefined);
  const seen = useRef(new Map());
  const closedInTurn = useRef(new Map());
  const active = opened && opened.conversation === conversationId ? opened : null;
  const close = () => { closedInTurn.current.set(conversationId, turn); setOpened(null); setFullscreen(false); };
  // When the agent makes an artifact (or a new version) the panel opens on it, unless the person closed it during this turn. What the
  // conversation already held when it loaded does not count, and a phone keeps to the card.
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
  // The versions of one file that the conversation presented or saved, newest first (the same scheme as the studio page).
  const newestOf = key => versions.filter(version => artifactKey(version) === key).reverse();
  const artifacts = useMemo(() => ({
    open: descriptor => setOpened({ conversation: conversationId, descriptor, follow: descriptor.revision === newestOf(artifactKey(descriptor))[0]?.revision }),
    isOpen: descriptor => Boolean(active && artifactKey(active.descriptor) === artifactKey(descriptor) && (active.follow ? descriptor.revision === newestOf(artifactKey(descriptor))[0]?.revision : descriptor.revision === active.descriptor.revision)),
    ...(detect ? { detect } : {}),
  }), [conversationId, active, versions, detect]); // eslint-disable-line react-hooks/exhaustive-deps
  setStudioContext({ variant: variant?.id, conversation: conversationId });
  useEffect(() => {
    if (!linked || chat.status !== 'ready') return;
    const known = newestOf(linked.id);
    // A link to an older version may name a revision the conversation never presented (the file's history has it).
    const found = linked.version === 'latest' ? known[0] : known.find(version => version.revision === linked.version) ?? (known[0] ? { ...known[0], revision: linked.version } : undefined);
    if (!found) return;
    setOpened({ conversation: conversationId, descriptor: found, follow: linked.version === 'latest' });
    setLinked(null);
  }, [linked, chat.status, versions, conversationId]);
  const scenarioRun = useScenarioRun({ storageKey: 'recipe.scenario', scenarios, variants: variant ? [variant] : [], variant, controller: chat.status === 'ready' ? chat.controller : undefined, conversationId, typed });
  if (!agent || !items) return <p className="cf-loading" role="status">Loading…</p>;
  const newConversation = async () => { const { conversationId: created } = await api('/api/conversations', { method: 'POST' }); await reload(); setSelected(created); };
  const refuse = async change => { const result = await chat.configure(change); if (result.kind === 'refused') throw new Error(result.reason ?? 'The change was refused.'); };
  const composer = chat.status === 'ready' ? {
    slash: { skills: agent.skills, commands: [{ name: 'new', description: 'Start a new conversation', run: () => { newConversation().catch(() => {}); } }] },
    model: { options: agent.models.map(model => ({ provider: model.provider, modelId: model.modelId, label: model.label })), change: model => refuse({ model }) },
    effort: { options: agent.efforts, change: level => refuse({ thinkingLevel: level }) },
  } : {};
  const conversations = { items: items.map(item => ({ id: String(item.id), title: item.title ?? undefined, updatedAt: item.updatedAt ?? undefined })),
    activeId: String(conversationId), onSelect: id => setSelected(Number(id)), onNew: () => { newConversation().catch(() => {}); } };
  // The shared document is the workspace file notes.md: the Document button opens its latest revision.
  const notes = { schema: 'boring.artifact', version: 1, title: 'notes.md', type: 'markdown', mediaType: 'text/markdown', target: agent.notes, revision: 'latest' };
  const known = active ? newestOf(artifactKey(active.descriptor)) : [];
  const chatCard = chat.status === 'ready'
    ? <PiChat key={conversationId} controller={chat.controller} title={agent.title} mode="developer" actions={chat.actions} artifacts={artifacts} conversations={conversations} {...composer}
        emptyState={scenarioRun.emptyState} decisions={scenarioRun.decisions}
        controls={<button type="button" className="cf-notes" data-testid="notes-open" onClick={() => setOpened({ conversation: conversationId, descriptor: newestOf(artifactKey(notes))[0] ?? notes, follow: true })}><NotebookTextIcon size={16} aria-hidden="true" />Document</button>} />
    : <p className="cf-loading" role="status">{chat.status === 'offline' ? 'Server unreachable. Retrying…' : 'Connecting…'}</p>;
  return <main className="cf" data-testid="studio-main" data-variant={variant.id} data-conversation={conversationId}>
    <ArtifactWorkspace open={Boolean(active)} onClose={close} fullscreen={fullscreen} onFullscreenChange={setFullscreen} storageKey="recipe.panel-width" sheetBelow={901}
      chat={<div className="cf-chat">{chatCard}</div>}
      panel={win => <ViewerWindowProvider value={{ fullscreen: win.fullscreen, onFullscreenChange: win.onFullscreenChange }}>
        <div className="cf-artifact" data-testid="viewer-panel">
          {active && <ArtifactPanel key={artifactKey(active.descriptor)} active={active} versions={known} api={api} authorized={authorized} identity={agent.identity} shareTarget={{ variant: variant.id, conversation: conversationId }}
            onSelect={value => setOpened({ conversation: conversationId, follow: value === 'latest', descriptor: value === 'latest' ? (known[0] ?? active.descriptor) : { ...active.descriptor, revision: value } })}
            onClose={win.close} />}
        </div></ViewerWindowProvider>} />
  </main>;
}

function App() {
  const [token, setToken] = useState(() => takeFragmentToken() || readStored());
  const [message, setMessage] = useState('');
  useEffect(() => { if (token) store(token); }, [token]);
  if (!token) return <Gate onToken={setToken} message={message} />;
  return <Workspace token={token} onRejected={() => { setMessage('That token was not accepted.'); setToken(''); try { sessionStorage.removeItem(KEY); } catch { /* optional */ } }} />;
}

createRoot(document.getElementById('root')).render(<App />);
