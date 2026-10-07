// The whole browser side of the app: the pi-app block and its hooks over the host routes of ./server.mjs. Nothing else is needed:
// sessions on the left, the chat in the center and the artifact viewers on the right come from `AgentWorkspace`.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentWorkspace, useConversations, useRemoteChat } from '../../registry/pi-app/agent-workspace.tsx';

const { token, identity } = window.__APP__;
const authorized = request => { const headers = new Headers(request.headers); headers.set('authorization', `Bearer ${token}`); return fetch(new Request(request, { headers })); };
const at = path => new URL(path, location.href);
const resources = { endpoint: at('/api/resources'), history: at('/api/history'), fetch: authorized, identity };

function App() {
  const [selected, setSelected] = useState();
  const conversations = useConversations({ endpoint: at('/api/conversations'), fetch: authorized, activeId: selected, onSelect: setSelected });
  // The open conversation: the one chosen, while it is listed; otherwise the most recent.
  const items = conversations?.items;
  useEffect(() => { if (items?.length && !items.some(item => item.id === selected)) setSelected(items[0].id); }, [items, selected]);
  const active = items?.some(item => item.id === selected) ? selected : undefined;
  const chat = useRemoteChat({ conversationId: active, endpoint: id => at(`/api/chat?conversation=${id}`), fetch: authorized, identity });
  return <main data-testid="app" data-conversation={active} className="flex h-full min-h-0">
    <AgentWorkspace conversationId={active} controller={chat.status === 'ready' ? chat.controller : undefined} conversations={conversations} resources={resources}
      chat={{ title: 'Writer', ...(chat.status === 'ready' ? { actions: chat.actions } : {}) }}
      connecting={<p role="status" className="p-4 text-sm text-muted-foreground">{chat.status === 'offline' ? 'Server unreachable. Retrying…' : 'Connecting…'}</p>} />
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
