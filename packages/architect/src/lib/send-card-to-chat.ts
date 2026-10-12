import { api } from './api';
import { getDeploymentConfig } from '../config/deployment';
import { useSettingsStore } from '../store/settings-store';
import { SillyTavernClient, shouldUseClientSidePush, type SillyTavernSettings } from './sillytavern-client';
import type { Card } from './types';

export type ChatDestination = 'SillyTavern' | 'Lumiverse';

async function getFederation() {
  if (getDeploymentConfig().mode !== 'full' || !useSettingsStore.getState().features.federationEnabled) return;
  try {
    const { useFederationStore } = await import('../modules/federation/lib/federation-store');
    if (!useFederationStore.getState().initialized) await useFederationStore.getState().initialize();
    return useFederationStore.getState();
  } catch (error) {
    console.warn('Unable to load federation for chat export:', error);
  }
}

/** Send a saved library card without changing the editor's current card. */
export async function sendCardToChat(card: Card, destination: ChatDestination): Promise<void> {
  if (card.meta.spec === 'collection' || card.meta.spec === 'lorebook') {
    throw new Error('Send individual character cards to chat.');
  }
  const isClientMode = getDeploymentConfig().mode !== 'full';
  if (destination === 'Lumiverse') {
    if (isClientMode) throw new Error('Sending to Lumiverse requires server mode.');
    const result = await api.pushToLumiverse(card.meta.id);
    if (result.error || !result.data?.success) throw new Error(result.error || 'Failed to send to Lumiverse.');
    return;
  }

  const federation = await getFederation();
  const platform = federation?.settings?.platforms?.sillytavern;
  if (platform?.enabled && platform.connected) {
    const result = await federation!.pushToST(card.meta.id);
    if (!result.success) throw new Error(result.error || 'Federation sync failed.');
    return;
  }

  let settings: SillyTavernSettings | undefined;
  if (isClientMode) {
    const stored = localStorage.getItem('ca-sillytavern-settings');
    if (stored) settings = JSON.parse(stored) as SillyTavernSettings;
    if (!settings) throw new Error('Configure SillyTavern in Settings first.');
  } else {
    settings = (await api.getSillyTavernSettings()).data?.settings;
  }

  let fileName: string | undefined;
  if (settings && (isClientMode || shouldUseClientSidePush(settings))) {
    let savedCard: Card;
    let png: Blob;
    if (isClientMode) {
      const { localDB } = await import('./db');
      savedCard = (await localDB.getCard(card.meta.id)) || card;
      const { exportCardAsPNG } = await import('./client-export');
      png = await exportCardAsPNG(savedCard);
    } else {
      const [current, exported] = await Promise.all([api.getCard(card.meta.id), api.exportCard(card.meta.id, 'png')]);
      if (current.error || !current.data) throw new Error(current.error || 'Unable to load card.');
      if (exported.error || !exported.data) throw new Error(exported.error || 'Unable to export card PNG.');
      savedCard = current.data;
      png = exported.data;
    }
    const result = await new SillyTavernClient(settings).push(savedCard, new Uint8Array(await png.arrayBuffer()));
    if (!result.success) throw new Error(result.error || 'Failed to send to SillyTavern.');
    fileName = result.fileName;
  } else {
    const result = await api.pushToSillyTavern(card.meta.id);
    if (result.error || !result.data?.success) throw new Error(result.error || result.data?.error || 'Failed to send to SillyTavern.');
    fileName = result.data.fileName;
  }

  if (federation) {
    try { await federation.recordManualSync(card.meta.id, 'sillytavern', fileName); }
    catch (error) { console.warn('Unable to record chat export sync state:', error); }
  }
}
