import type { Actor } from '@character-unity/cards';
import type { ChatService } from '@character-unity/cards/chat';

/**
 * Keeps "where it lives" current: scans every connected chat app on a timer. One pass at a time;
 * failures are recorded on the target by the scan itself and never stop the loop.
 */
export function startChatRefresh(options: { chat: ChatService; workspaces: (actor: Actor) => Promise<{ id: string }[]>; actor: Actor; intervalMs: number; log?: (event: Record<string, unknown>) => void }) {
  let running = false;
  async function pass() {
    if (running) return;
    running = true;
    try {
      for (const workspace of await options.workspaces(options.actor)) {
        for (const target of await options.chat.targets(options.actor, workspace.id)) {
          try {
            const { found } = await options.chat.scan(options.actor, workspace.id, target.id);
            options.log?.({ event: 'chat-scan', target: target.id, found });
          } catch (error) {
            options.log?.({ event: 'chat-scan-failed', target: target.id, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    } finally { running = false; }
  }
  const first = setTimeout(() => void pass(), 5_000);
  const timer = setInterval(() => void pass(), options.intervalMs);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
