import { useEffect, useState } from 'react';
import { createNativeChatController } from '@boring/ui/native-chat';
import { createRemoteChat } from '@boring/ui/remote-chat';

/**
 * One controller per selected conversation, shared by the example browsers. A dropped stream is retried; it never means the
 * task stopped. `authorized` is the host's authenticated `fetch`.
 */
export function useChat(conversationId, authorized, identity) {
  const [chat, setChat] = useState({ status: 'connecting', conversationId });
  useEffect(() => {
    if (conversationId === undefined) return;
    let disposed = false, controller, timer, remote;
    setChat({ status: 'connecting', conversationId });
    (async () => {
      for (;;) {
        try {
          remote = await createRemoteChat({ endpoint: new URL(`/api/chat?conversation=${conversationId}`, location.href), fetch: authorized });
          if (disposed) return void remote.close();
          controller = createNativeChatController({ identity, ...remote });
          await controller.connect();
          if (disposed) return void controller.dispose();
          // Human-in-the-loop answers and queue withdrawal are optional on the transport: pass only what it offers.
          const actions = {};
          if (typeof remote.answer === 'function') actions.answer = remote.answer;
          if (typeof remote.withdraw === 'function') actions.withdraw = remote.withdraw;
          setChat({ status: 'ready', controller, conversationId, actions, configure: remote.configure });
          timer = setInterval(() => { const kind = controller.getSnapshot().connection.kind; if (kind === 'closed' || kind === 'error') controller.connect().catch(() => {}); }, 1000);
          return;
        } catch (error) {
          controller?.dispose(); controller = undefined; void remote?.close(); remote = undefined;
          if (disposed) return;
          setChat({ status: 'offline', conversationId, error: String(error?.message ?? error) });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    })();
    return () => { disposed = true; clearInterval(timer); controller?.dispose(); void remote?.close(); };
  }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Never hand a previous conversation's controller to the panel: it is disposed as soon as the selection changes.
  return chat.conversationId === conversationId ? chat : { status: 'connecting', conversationId };
}
