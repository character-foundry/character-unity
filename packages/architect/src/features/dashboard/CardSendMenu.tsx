import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { portalRoot } from '../../unity/config';
import { ChatExportMenu } from '../../components/shared/ChatExportMenu';
import { useSettingsStore } from '../../store/settings-store';
import { getDeploymentConfig } from '../../config/deployment';
import { sendCardToChat, type ChatDestination } from '../../lib/send-card-to-chat';
import type { Card } from '../../lib/types';

export function CardSendMenu({ card }: { card: Card }) {
  const sillyTavernEnabled = useSettingsStore(state => state.features.sillytavernEnabled ?? false);
  const lumiverseEnabled = useSettingsStore(state => state.features.lumiverseEnabled ?? false);
  const [status, setStatus] = useState<{ error: boolean; message: string } | null>(null);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), status.error ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [status]);

  if (card.meta.spec === 'collection' || card.meta.spec === 'lorebook') return null;

  async function send(destination: ChatDestination) {
    setStatus(null);
    try {
      await sendCardToChat(card, destination);
      setStatus({ error: false, message: `Sent ${card.meta.name || 'card'} to ${destination}` });
    } catch (error) {
      setStatus({ error: true, message: error instanceof Error ? error.message : `Unable to send to ${destination}` });
    }
  }

  return (
    <>
      <ChatExportMenu variant="icon" placement="above"
        onSillyTavern={sillyTavernEnabled ? () => send('SillyTavern') : undefined}
        onLumiverse={lumiverseEnabled && getDeploymentConfig().mode === 'full' ? () => send('Lumiverse') : undefined}
      />
      {status && createPortal(
        <div role={status.error ? 'alert' : 'status'} onClick={event => event.stopPropagation()} className={`fixed bottom-4 right-4 max-w-[calc(100vw-2rem)] px-4 py-3 rounded-lg shadow-lg z-[200] text-sm text-white ${status.error ? 'bg-red-600' : 'bg-green-600'}`}>
          {status.message}
        </div>, portalRoot()
      )}
    </>
  );
}
