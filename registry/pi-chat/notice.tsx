'use client';

import type { ReactNode } from 'react';
import type { NativeChatSnapshot } from '@boring/ui/native-chat';
import { Button } from '../button/button';
import { cn } from '../utils/utils';

export function Notice({ tone = 'error', children, testid }: { readonly tone?: 'error' | 'info'; readonly children: ReactNode; readonly testid?: string }) {
  return <div role={tone === 'error' ? 'alert' : 'status'} {...(testid ? { 'data-testid': testid } : {})}
    className={cn('flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm', tone === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted/60 text-muted-foreground')}>{children}</div>;
}

/** What went wrong with sending or stopping, and the recovery for an unknown submission. Shared by every chat surface. */
export function ChatNotices({ state, error, onReconcile, onRetry }: {
  readonly state: Pick<NativeChatSnapshot, 'send' | 'stop'>;
  readonly error: string | null;
  readonly onReconcile: () => void;
  readonly onRetry: () => void;
}) {
  return <>
    {error && <Notice testid="chat-error">{error}</Notice>}
    {state.send.kind === 'blocked' && <Notice testid="send-blocked">{state.send.reason}</Notice>}
    {state.send.kind === 'unknown' && <Notice testid="send-unknown"><span className="flex-1">Submission acknowledgement is unknown. Your draft is retained.</span>
      <Button size="sm" variant="outline" onClick={onReconcile}>Check original submission</Button>
      <Button size="sm" variant="outline" onClick={onRetry}>Retry same request</Button></Notice>}
    {state.stop === 'requested' && <Notice tone="info" testid="stop-requested">Stop requested. Waiting for native confirmation.</Notice>}
    {state.stop === 'unconfirmed' && <Notice testid="stop-unconfirmed">Stop is unconfirmed. Work may still be running.</Notice>}
  </>;
}
