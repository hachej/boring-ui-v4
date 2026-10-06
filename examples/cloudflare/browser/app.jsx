// Browser side of the Cloudflare recipe: the pi-chat registry item and the artifact panel over the remote chat transport, with the SAME
// scenario list as the studio (scenarios/*.mjs described at build time into scenarios.json). No Pi runtime is bundled. The access token is
// entered once, kept in sessionStorage (when allowed) and sent as a bearer header.
//
// A link the agent sent (`/v/<link>`, see src/view-links.mjs) opens this page instead: the link is exchanged for a session token
// (`POST /api/session`), the link's conversation is selected and the linked workspace file or the shared document opens in its editor
// beside the chat (a link made before artifacts became files names an artifact; the object answers with its file). The session is renewed from the link before it expires, for as long as the link is valid.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FolderOpenIcon, MessageSquareIcon, NotebookTextIcon } from 'lucide-react';
import { PiChat, artifactKey } from '../../../registry/pi-chat/pi-chat.tsx';
import { ArtifactWorkspace } from '../../../registry/pi-workspace/workspace.tsx';
import { ViewerFrame, ViewerWindowProvider } from '../../../registry/viewers/viewer-frame.tsx';
import { useChat } from '../../shared/use-chat.mjs';
import { ArtifactPanel, useArtifactVersions, useTurn, useTyped } from '../../studio/artifact-panel.jsx';
import { useScenarioRun } from '../../studio/scenarios-ui.jsx';
import { savedResource } from '../../studio/saved-resource.mjs';
import { setStudioContext, takeLink } from '../../studio/share-link.mjs';
import { FileViewer } from '../../studio/file-viewer.jsx';

const KEY = 'recipe.token', LINK_KEY = 'recipe.link';
/** A person signed in through the hub has no token: their session is an HttpOnly cookie the browser sends itself. */
const COOKIE = '\u0000cookie';
const readKey = key => { try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; } };
const writeKey = (key, value) => { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* optional convenience */ } };
const readStored = () => readKey(KEY);
const store = token => writeKey(KEY, token === COOKIE ? '' : token);
const WORKSPACE = '/workspace/';

/** The link the page was opened with (`/v/<link>`), taken once: the address bar goes back to `/` and the link is kept in this tab only. */
function takePathLink() {
  if (!location.pathname.startsWith('/v/')) return '';
  const link = decodeURIComponent(location.pathname.slice(3));
  history.replaceState(null, '', `/${location.hash}`);
  return link;
}

/** A view link exchanged for a session: `{ token, expiresAt, conversation?, opens? }`. Throws `link-invalid` when it is expired or tampered. */
async function exchange(link) {
  const response = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link }) });
  if (response.status === 401) throw new Error('link-invalid');
  if (!response.ok) throw new Error(`session: ${response.status}`);
  return response.json();
}

/** The workspace's files (from /api/files, `.git` left out), refreshed while open. A file opens in its viewer in the same panel. */
function FileList({ api, onOpen, onClose }) {
  const [files, setFiles] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => api('/api/files').then(result => { if (!cancelled) setFiles(result.files.filter(file => !file.path.startsWith('.git/'))); }).catch(() => {});
    load();
    const timer = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api]);
  return <ViewerFrame title="Files" subtitle={<span>The agent's workspace</span>} testId="files-panel" onClose={onClose}>
    <div className="cf-files min-h-0 flex-1 overflow-auto p-3">
      {files === null ? <p role="status" className="cf-loading">Loading…</p> : files.length === 0 ? <p className="cf-loading">No files yet.</p>
        : <ul>{files.map(file => <li key={file.path}><button type="button" data-testid="file-item" data-path={file.path} onClick={() => onOpen(`${WORKSPACE}${file.path}`)}>{file.path}</button></li>)}</ul>}
    </div>
  </ViewerFrame>;
}

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

function Workspace({ token, onRejected, opening, attempt }) {
  // A renewed session token replaces the old one without reconnecting anything: every request reads the current one.
  const held = useRef(token);
  held.current = token;
  const authorized = useMemo(() => request => {
    if (held.current === COOKIE) return fetch(request);
    const headers = new Headers(request.headers); headers.set('authorization', `Bearer ${held.current}`); return fetch(new Request(request, { headers }));
  }, []);
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
  const [selected, setSelected] = useState(() => { const linked = Number(opening?.conversation ?? takeLink('conversation')); if (linked) return linked; try { return Number(sessionStorage.getItem('recipe.conversation')) || undefined; } catch { return undefined; } });
  const [linked, setLinked] = useState(() => { const id = takeLink('artifact'); return id ? { id, version: takeLink('version') ?? 'latest' } : null; });
  // A view link's file or the shared document, opened once the conversation is known.
  const [pending, setPending] = useState(() => {
    if (opening?.opens?.kind === 'file' || opening?.opens?.kind === 'notes') return opening.opens;
    const file = takeLink('file'); return file ? { kind: 'file', path: file.replace(/^\/workspace\//, '') } : null;
  });
  // The open artifact survives a reload, as in the studio.
  const [opened, setOpened] = useState(() => { try { return JSON.parse(sessionStorage.getItem('recipe.artifact') ?? 'null'); } catch { return null; } });
  useEffect(() => { try { sessionStorage.setItem('recipe.artifact', JSON.stringify(opened)); } catch { /* optional convenience */ } }, [opened]);
  const [fullscreen, setFullscreen] = useState(false);
  const reload = () => api('/api/conversations').then(result => setItems(result.conversations)).catch(() => {});
  // Loaded again after a refused request was followed by a renewed session (`attempt`), so a page never stays on Loading….
  useEffect(() => {
    api('/api/agent').then(setAgent).catch(() => {});
    // The scenario descriptions were written next to the page at build time: the same files the studio lists.
    fetch('/scenarios.json').then(response => response.json()).then(setScenarios).catch(() => {});
    reload();
    const timer = setInterval(reload, 4000);
    return () => clearInterval(timer);
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const shown = opened && opened.conversation === conversationId ? opened : null;
  const active = shown && !shown.kind ? shown : null;
  const activeFile = shown?.kind === 'file' ? shown : null;
  const activeFiles = shown?.kind === 'files' ? shown : null;
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
  useEffect(() => {
    if (!pending || !agent || conversationId === undefined) return;
    if (pending.kind === 'file') setOpened({ conversation: conversationId, kind: 'file', path: `${WORKSPACE}${pending.path}` });
    else setOpened({ conversation: conversationId, descriptor: { schema: 'boring.artifact', version: 1, title: 'notes.md', type: 'markdown', mediaType: 'text/markdown', target: agent.notes, revision: 'latest' }, follow: true });
    setPending(null);
  }, [pending, agent, conversationId]);
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
        controls={<>
          <button type="button" className="cf-notes" data-testid="notes-open" onClick={() => setOpened({ conversation: conversationId, descriptor: newestOf(artifactKey(notes))[0] ?? notes, follow: true })}><NotebookTextIcon size={16} aria-hidden="true" />Document</button>
          <button type="button" className="cf-notes" data-testid="files-open" onClick={() => setOpened({ conversation: conversationId, kind: 'files' })}><FolderOpenIcon size={16} aria-hidden="true" />Files</button>
        </>} />
    : <p className="cf-loading" role="status">{chat.status === 'offline' ? 'Server unreachable. Retrying…' : 'Connecting…'}</p>;
  return <main className="cf" data-testid="studio-main" data-variant={variant.id} data-conversation={conversationId}>
    <ArtifactWorkspace open={Boolean(shown)} onClose={close} fullscreen={fullscreen} onFullscreenChange={setFullscreen} storageKey="recipe.panel-width" sheetBelow={901}
      chat={<div className="cf-chat">{chatCard}</div>}
      panel={win => <ViewerWindowProvider value={{ fullscreen: win.fullscreen, onFullscreenChange: win.onFullscreenChange }}>
        <div className="cf-artifact" data-testid="viewer-panel" data-kind={active ? 'artifact' : activeFile ? 'file' : 'files'}>
          {activeFiles && <FileList api={api} onOpen={path => setOpened({ conversation: conversationId, kind: 'file', path })} onClose={win.close} />}
          {activeFile && <FileViewer key={activeFile.path} path={activeFile.path} agentId={variant.id} api={api} authorized={authorized} identity={agent.identity} onClose={win.close}
            onBack={() => setOpened({ conversation: conversationId, kind: 'files' })} backLabel="Files" />}
          {active && <ArtifactPanel key={artifactKey(active.descriptor)} active={active} versions={known} api={api} authorized={authorized} identity={agent.identity} shareTarget={{ variant: variant.id, conversation: conversationId }}
            onSelect={value => setOpened({ conversation: conversationId, follow: value === 'latest', descriptor: value === 'latest' ? (known[0] ?? active.descriptor) : { ...active.descriptor, revision: value } })}
            onClose={win.close} />}
          {/* On a phone the document covers the chat: this goes back to it (the chat's Document and Files buttons come back here). */}
          {win.sheet && <button type="button" className="cf-open-chat" data-testid="open-chat" onClick={win.close}><MessageSquareIcon size={18} aria-hidden="true" />Chat</button>}
        </div></ViewerWindowProvider>} />
  </main>;
}

function App() {
  // A view link in the address wins over a token this tab already holds; the link is kept to renew the session.
  const [fresh] = useState(takePathLink);
  const [link, setLink] = useState(() => fresh || readKey(LINK_KEY));
  const [session, setSession] = useState(null);
  const [opening, setOpening] = useState(null);
  const [token, setToken] = useState(() => fresh ? '' : takeFragmentToken() || readStored());
  const [message, setMessage] = useState('');
  // With a link (in the address or kept from it), the page exchanges it before mounting the workspace: after a reload the stored
  // session token may have expired, and nothing would renew it once every first request had been refused.
  const [exchanged, setExchanged] = useState(() => !link);
  const [attempt, setAttempt] = useState(0);
  // Without a token or a link, a signed-in person's cookie may still open their own agent: ask once before showing the token form.
  const [probed, setProbed] = useState(() => Boolean(token || link));
  useEffect(() => {
    if (probed) return;
    fetch('/api/agent').then(response => { if (response.ok) setToken(COOKIE); }).catch(() => {}).finally(() => setProbed(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (token) store(token); }, [token]);
  useEffect(() => { writeKey(LINK_KEY, link); }, [link]);
  const forget = text => { setMessage(text); setToken(''); setLink(''); setSession(null); writeKey(KEY, ''); };
  const renew = async () => {
    try { const next = await exchange(link); setSession(next); setToken(next.token); return next; }
    catch (error) { if (error.message === 'link-invalid') forget('This link has expired or is not valid. Ask the agent for a new one.'); return undefined; }
  };
  useEffect(() => {
    if (!link) return;
    let stopped = false;
    (async () => {
      for (;;) {
        try {
          const next = await exchange(link);
          if (stopped) return;
          setSession(next); setToken(next.token);
          if (fresh) setOpening({ conversation: next.conversation, opens: next.opens });
          setExchanged(true);
          return;
        } catch (error) {
          if (stopped) return;
          if (error.message === 'link-invalid') { forget('This link has expired or is not valid. Ask the agent for a new one.'); setExchanged(true); return; }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    })();
    return () => { stopped = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Renew before the session expires (a session is at most 24 hours; the link stays valid for 7 days).
  useEffect(() => {
    if (!session || !link) return;
    const timer = setTimeout(renew, Math.max(5000, (session.expiresAt - Date.now()) * 0.8));
    return () => clearTimeout(timer);
  }, [session, link]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!exchanged) return <p className="cf-loading" role="status" data-testid="link-opening">Opening the link…</p>;
  if (!probed) return <p className="cf-loading" role="status">Loading…</p>;
  if (!token) return <Gate onToken={value => { setMessage(''); setToken(value); }} message={message} />;
  return <Workspace token={token} opening={opening} attempt={attempt}
    onRejected={() => { if (token === COOKIE) { location.assign('/'); return; } if (link) renew().then(next => { if (next) setAttempt(value => value + 1); }); else forget('That token was not accepted.'); }} />;
}

createRoot(document.getElementById('root')).render(<App />);
