import { useEffect, useState } from 'react';
import { createNativeChatController } from '@boring/ui/native-chat';
import type { ChatIdentity, NativeChatController } from '@boring/ui/native-chat';
import { createRemoteChat } from '@boring/ui/remote-chat';
import type { RemoteChat } from '@boring/ui/remote-chat';
import type { PiChatActions } from '../pi-chat/pi-chat';

export type RemoteChatState =
  | { readonly status: 'connecting'; readonly conversationId: string | undefined }
  | { readonly status: 'offline'; readonly conversationId: string | undefined; readonly error: string }
  | { readonly status: 'ready'; readonly conversationId: string; readonly controller: NativeChatController; readonly actions: PiChatActions; readonly configure: RemoteChat['configure'] };

/**
 * One native chat controller per selected conversation over the host's chat transport (`createChatTransportHandler` of
 * `@boring/agent/chat-transport`). `endpoint(id)` names the transport URL of a conversation; `fetch` is the host's authenticated fetch.
 * The remote chat reopens a dropped stream itself (the controller reads `reconnecting` meanwhile); it never means the task stopped.
 * A failed connect retries every second. The previous conversation's controller is never handed out: it is disposed on change.
 */
export function useRemoteChat({ conversationId, endpoint, fetch, identity }: {
  readonly conversationId: string | undefined;
  readonly endpoint: (conversationId: string) => string | URL;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly identity: ChatIdentity | undefined;
}): RemoteChatState {
  const [chat, setChat] = useState<RemoteChatState>({ status: 'connecting', conversationId });
  const ready = identity !== undefined;
  useEffect(() => {
    if (conversationId === undefined || !identity) return;
    let disposed = false, controller: NativeChatController | undefined, remote: RemoteChat | undefined;
    setChat({ status: 'connecting', conversationId });
    void (async () => {
      for (;;) {
        try {
          remote = await createRemoteChat({ endpoint: endpoint(conversationId), fetch });
          if (disposed) return void remote.close();
          controller = createNativeChatController({ identity, ...remote });
          await controller.connect();
          if (disposed) return void controller.dispose();
          // Human-in-the-loop answers and queue withdrawal are optional on the transport: pass only what it offers.
          const actions: { answer?: RemoteChat['answer']; withdraw?: RemoteChat['withdraw'] } = {};
          if (typeof remote.answer === 'function') actions.answer = remote.answer;
          if (typeof remote.withdraw === 'function') actions.withdraw = remote.withdraw;
          setChat({ status: 'ready', controller, conversationId, actions, configure: remote.configure });
          return;
        } catch (error) {
          controller?.dispose(); controller = undefined; void remote?.close(); remote = undefined;
          if (disposed) return;
          setChat({ status: 'offline', conversationId, error: String((error as Error)?.message ?? error) });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    })();
    return () => { disposed = true; controller?.dispose(); void remote?.close(); };
  }, [conversationId, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  return chat.conversationId === conversationId ? chat : { status: 'connecting', conversationId };
}
