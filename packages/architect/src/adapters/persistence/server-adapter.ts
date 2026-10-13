/**
 * Server Persistence Adapter
 *
 * Implements PersistenceAdapter using server API calls.
 * Used in 'full' deployment mode.
 */

import type { Card, Template, Snippet, CardAssetWithDetails } from '../../lib/types';
import { api } from '../../lib/api';
import { EditorPreferences } from './editor-preferences';
import { editorAssets } from '../../unity/assets';
import { useCardStore } from '../../store/card-store';
import type {
  PersistenceAdapter,
  CardListItem,
  AssetSaveOptions,
  AssetUpdateOptions,
  Version,
  ImageType,
} from './types';

const preferences = new EditorPreferences();
function draft(cardId: string): Card {
  const card = useCardStore.getState().currentCard;
  if (!card || card.meta.id !== cardId) throw new Error('Open this card in the editor before changing its assets');
  return card;
}
function dirty() { useCardStore.setState({ isDirty: true }); }

export class ServerPersistenceAdapter implements PersistenceAdapter {
  readonly mode = 'server' as const;

  // ============================================
  // Cards
  // ============================================

  async listCards(query?: string): Promise<CardListItem[]> {
    const { data, error } = await api.listCards(query);
    if (error || !data?.items) {
      console.error('[ServerAdapter] listCards error:', error);
      return [];
    }
    return data.items.map((card: Card) => ({
      id: card.meta.id,
      name: card.meta.name,
      spec: card.meta.spec,
      tags: card.meta.tags || [],
      thumbnailUrl: api.getCardImageUrl(card.meta.id),
      createdAt: card.meta.createdAt,
      updatedAt: card.meta.updatedAt,
    }));
  }

  async getCard(id: string): Promise<Card | null> {
    const { data, error } = await api.getCard(id);
    if (error || !data) {
      console.error('[ServerAdapter] getCard error:', error);
      return null;
    }
    return data;
  }

  async saveCard(card: Card): Promise<Card> {
    if (card.meta.id) {
      // Update existing
      const { data, error } = await api.updateCard(card.meta.id, card);
      if (error) throw new Error(error);
      return data || card;
    } else {
      // Create new
      const { data, error } = await api.createCard(card);
      if (error) throw new Error(error);
      if (!data) throw new Error('No card returned from server');
      return data;
    }
  }

  async deleteCard(id: string): Promise<void> {
    const { error } = await api.deleteCard(id);
    if (error) throw new Error(error);
  }

  // ============================================
  // Assets
  // ============================================

  async listAssets(cardId: string): Promise<CardAssetWithDetails[]> {
    const card = draft(cardId);
    const assets = await editorAssets.list(card);
    return assets.map((asset, order) => ({ id: asset.id, assetId: asset.id, cardId, name: asset.name, type: asset.type,
      ext: asset.ext ?? '', order, isMain: asset.main, tags: asset.tags, createdAt: card.meta.createdAt, updatedAt: card.meta.updatedAt,
      asset: { id: asset.id, filename: asset.name, mimetype: asset.mediaType, size: asset.byteLength, url: asset.url, createdAt: card.meta.createdAt } }));
  }

  async saveAsset(options: AssetSaveOptions): Promise<CardAssetWithDetails> {
    const { cardId, name, type, data, isMain = false, tags = [] } = options;

    // Convert data to File if needed
    let file: File;
    if (data instanceof File) {
      file = data;
    } else if (typeof data === 'string') {
      // Data URL - convert to blob
      const response = await fetch(data);
      const blob = await response.blob();
      file = new File([blob], `${name}.${options.ext}`, { type: options.mimetype });
    } else {
      // Uint8Array - copy to new ArrayBuffer to ensure correct type
      const blob = new Blob([new Uint8Array(data)], { type: options.mimetype });
      file = new File([blob], `${name}.${options.ext}`, { type: options.mimetype });
    }

    const card = draft(cardId);
    const id = await editorAssets.add(card, file, { type, name, main: isMain, tags });
    dirty();
    const values = await this.listAssets(cardId);
    const saved = values.find((asset) => asset.id === id);
    if (!saved) throw new Error('The asset draft could not be opened');
    return saved;
  }

  async updateAsset(cardId: string, assetId: string, updates: AssetUpdateOptions): Promise<void> {
    editorAssets.update(draft(cardId), assetId, updates); dirty();
  }

  async deleteAsset(cardId: string, assetId: string): Promise<void> {
    editorAssets.remove(draft(cardId), assetId); dirty();
  }

  async setAssetAsMain(cardId: string, assetId: string): Promise<void> {
    editorAssets.setMainBackground(draft(cardId), assetId); dirty();
  }

  // ============================================
  // Templates
  // ============================================

  async listTemplates(): Promise<Template[]> {
    return preferences.listTemplates();
  }

  async createTemplate(template: Omit<Template, 'id' | 'createdAt' | 'updatedAt'>): Promise<Template> {
    return preferences.createTemplate(template);
  }

  async updateTemplate(
    id: string,
    updates: Partial<Omit<Template, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<Template> {
    return preferences.updateTemplate(id, updates);
  }

  async deleteTemplate(id: string): Promise<void> {
    return preferences.deleteTemplate(id);
  }

  async resetTemplates(): Promise<Template[]> {
    return preferences.resetTemplates();
  }

  // ============================================
  // Snippets
  // ============================================

  async listSnippets(): Promise<Snippet[]> {
    return preferences.listSnippets();
  }

  async createSnippet(snippet: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>): Promise<Snippet> {
    return preferences.createSnippet(snippet);
  }

  async updateSnippet(
    id: string,
    updates: Partial<Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<Snippet> {
    return preferences.updateSnippet(id, updates);
  }

  async deleteSnippet(id: string): Promise<void> {
    return preferences.deleteSnippet(id);
  }

  async resetSnippets(): Promise<Snippet[]> {
    return preferences.resetSnippets();
  }

  // ============================================
  // Versions
  // ============================================

  async listVersions(cardId: string): Promise<Version[]> {
    const { data, error } = await api.listVersions(cardId);
    if (error || !data) {
      console.error('[ServerAdapter] listVersions error:', error);
      return [];
    }
    return data.map((version) => ({ id: version.id, cardId, versionNumber: version.version, createdAt: version.createdAt,
      message: version.message, data: version.data }));
  }

  // ============================================
  // Images
  // ============================================

  async saveImage(cardId: string, type: ImageType, data: string): Promise<void> {
    if (type !== 'icon' && type !== 'thumbnail') throw new Error('Use the asset panel to add attachments');
    const response = await fetch(data);
    if (!response.ok) throw new Error('Portrait could not be read');
    const image = await response.blob();
    await editorAssets.setPortrait(draft(cardId), new File([image], 'portrait', { type: image.type })); dirty();
  }

  async getImage(cardId: string, type: ImageType): Promise<string | null> {
    // Return the URL for server-side images
    if (type === 'thumbnail' || type === 'icon') {
      return api.getCardImageUrl(cardId);
    }
    return null;
  }

  getCardImageUrl(cardId: string): string {
    return api.getCardImageUrl(cardId);
  }

  // ============================================
  // Settings (not implemented - API doesn't have generic KV store)
  // ============================================

  async getSetting<T>(key: string): Promise<T | null> {
    return preferences.getSetting<T>(key);
  }

  async saveSetting<T>(key: string, value: T): Promise<void> {
    return preferences.saveSetting(key, value);
  }
}
