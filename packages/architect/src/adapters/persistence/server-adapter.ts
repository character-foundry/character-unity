/** Native persistence for one explicitly owned editor draft. */
import type { Card, Template, Snippet, CardAssetWithDetails } from '../../lib/types';
import type { UnityApiClient } from '../../lib/api';
import { EditorPreferences } from './editor-preferences';
import type { EditorAssetService } from '../../unity/assets';
import type { CardStore } from '../../store/card-store';
import type { StoreApi } from 'zustand/vanilla';
import type {
  PersistenceAdapter,
  CardListItem,
  AssetSaveOptions,
  AssetUpdateOptions,
  Version,
  ImageType,
} from './types';

export class ServerPersistenceAdapter implements PersistenceAdapter {
  readonly mode = 'server' as const;
  private readonly preferences = new EditorPreferences();
  constructor(private readonly api: UnityApiClient, private readonly assets: EditorAssetService,
    private readonly cards: StoreApi<CardStore>, private readonly signal: AbortSignal) {}

  private draft(cardId: string): Card {
    this.signal.throwIfAborted();
    const card = this.cards.getState().currentCard;
    if (!card || card.meta.id !== cardId) throw new Error('Open this card in the editor before changing its assets');
    return card;
  }
  private selected(generation: number) {
    this.signal.throwIfAborted();
    if (this.cards.getState().selectionVersion !== generation) throw new Error('The editor selection changed');
  }
  private dirty(generation: number) { this.selected(generation); this.cards.setState({ isDirty: true }); }
  private async dataFile(data: string, name: string, mediaType?: string): Promise<File> {
    if (!data.startsWith('data:')) throw new Error('Expected an image or asset data URL');
    this.signal.throwIfAborted();
    const response = await fetch(data, { signal: this.signal });
    if (!response.ok) throw new Error('Asset data could not be read');
    const blob = await response.blob();
    this.signal.throwIfAborted();
    return new File([blob], name, { type: mediaType ?? blob.type });
  }

  // ============================================
  // Cards
  // ============================================

  async listCards(query?: string): Promise<CardListItem[]> {
    const { data, error } = await this.api.listCards(query);
    if (error || !data?.items) throw new Error(error ?? 'Card list was unavailable');
    return data.items.map((card: Card) => ({
      id: card.meta.id,
      name: card.meta.name,
      spec: card.meta.spec,
      tags: card.meta.tags || [],
      thumbnailUrl: this.api.getCardImageUrl(card.meta.id),
      createdAt: card.meta.createdAt,
      updatedAt: card.meta.updatedAt,
    }));
  }

  async getCard(id: string): Promise<Card | null> {
    const { data, error } = await this.api.getCard(id, { signal: this.signal, pinHead: false });
    if (error) throw new Error(error);
    return data ?? null;
  }

  async saveCard(card: Card): Promise<Card> {
    if (card.meta.id) {
      // Update existing
      const { data, error } = await this.api.updateCard(card.meta.id, card);
      if (error) throw new Error(error);
      if (!data) throw new Error('No card returned from server');
      return data;
    } else {
      // Create new
      const { data, error } = await this.api.createCard(card);
      if (error) throw new Error(error);
      if (!data) throw new Error('No card returned from server');
      return data;
    }
  }

  async deleteCard(id: string): Promise<void> {
    const { error } = await this.api.deleteCard(id);
    if (error) throw new Error(error);
  }

  // ============================================
  // Assets
  // ============================================

  async listAssets(cardId: string): Promise<CardAssetWithDetails[]> {
    const card = this.draft(cardId);
    const generation = this.cards.getState().selectionVersion;
    const assets = await this.assets.list(card);
    this.selected(generation);
    return assets.map((asset, order) => ({ id: asset.id, assetId: asset.id, cardId, name: asset.name, type: asset.type,
      ext: asset.ext ?? '', order, isMain: asset.main, tags: asset.tags, createdAt: card.meta.createdAt, updatedAt: card.meta.updatedAt,
      asset: { id: asset.id, filename: asset.name, mimetype: asset.mediaType, size: asset.byteLength, url: asset.url, createdAt: card.meta.createdAt } }));
  }

  async saveAsset(options: AssetSaveOptions): Promise<CardAssetWithDetails> {
    const { cardId, name, type, data, isMain = false, tags = [] } = options;
    const card = this.draft(cardId);
    const generation = this.cards.getState().selectionVersion;

    // Convert data to File if needed
    let file: File;
    if (data instanceof File) {
      file = data;
    } else if (typeof data === 'string') {
      // Data URL - convert to blob
      file = await this.dataFile(data, `${name}.${options.ext}`, options.mimetype);
    } else {
      // Uint8Array - copy to new ArrayBuffer to ensure correct type
      const blob = new Blob([new Uint8Array(data)], { type: options.mimetype });
      file = new File([blob], `${name}.${options.ext}`, { type: options.mimetype });
    }

    this.selected(generation);
    const id = await this.assets.add(card, file, { type, name, main: isMain, tags });
    this.dirty(generation);
    const values = await this.listAssets(cardId);
    const saved = values.find((asset) => asset.id === id);
    if (!saved) throw new Error('The asset draft could not be opened');
    return saved;
  }

  async updateAsset(cardId: string, assetId: string, updates: AssetUpdateOptions): Promise<void> {
    const generation = this.cards.getState().selectionVersion;
    this.assets.update(this.draft(cardId), assetId, updates); this.dirty(generation);
  }

  async deleteAsset(cardId: string, assetId: string): Promise<void> {
    const generation = this.cards.getState().selectionVersion;
    this.assets.remove(this.draft(cardId), assetId); this.dirty(generation);
  }

  async setAssetAsMain(cardId: string, assetId: string): Promise<void> {
    const generation = this.cards.getState().selectionVersion;
    this.assets.setMainBackground(this.draft(cardId), assetId); this.dirty(generation);
  }

  // ============================================
  // Templates
  // ============================================

  async listTemplates(): Promise<Template[]> {
    return this.preferences.listTemplates();
  }

  async createTemplate(template: Omit<Template, 'id' | 'createdAt' | 'updatedAt'>): Promise<Template> {
    return this.preferences.createTemplate(template);
  }

  async updateTemplate(
    id: string,
    updates: Partial<Omit<Template, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<Template> {
    return this.preferences.updateTemplate(id, updates);
  }

  async deleteTemplate(id: string): Promise<void> {
    return this.preferences.deleteTemplate(id);
  }

  async resetTemplates(): Promise<Template[]> {
    return this.preferences.resetTemplates();
  }

  // ============================================
  // Snippets
  // ============================================

  async listSnippets(): Promise<Snippet[]> {
    return this.preferences.listSnippets();
  }

  async createSnippet(snippet: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>): Promise<Snippet> {
    return this.preferences.createSnippet(snippet);
  }

  async updateSnippet(
    id: string,
    updates: Partial<Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<Snippet> {
    return this.preferences.updateSnippet(id, updates);
  }

  async deleteSnippet(id: string): Promise<void> {
    return this.preferences.deleteSnippet(id);
  }

  async resetSnippets(): Promise<Snippet[]> {
    return this.preferences.resetSnippets();
  }

  // ============================================
  // Versions
  // ============================================

  async listVersions(cardId: string): Promise<Version[]> {
    const { data, error } = await this.api.listVersions(cardId);
    if (error || !data) throw new Error(error ?? 'Revision history was unavailable');
    return data.map((version) => ({ id: version.id, cardId, versionNumber: version.version, createdAt: version.createdAt,
      message: version.message, data: version.data }));
  }

  // ============================================
  // Images
  // ============================================

  async saveImage(cardId: string, type: ImageType, data: string): Promise<void> {
    if (type !== 'icon' && type !== 'thumbnail') throw new Error('Use the asset panel to add attachments');
    const card = this.draft(cardId);
    const generation = this.cards.getState().selectionVersion;
    const image = await this.dataFile(data, 'portrait');
    this.selected(generation);
    await this.assets.setPortrait(card, image); this.dirty(generation);
  }

  async getImage(cardId: string, type: ImageType): Promise<string | null> {
    // Return the URL for server-side images
    if (type === 'thumbnail' || type === 'icon') {
      return this.api.getCardImageUrl(cardId);
    }
    return null;
  }

  getCardImageUrl(cardId: string): string {
    return this.api.getCardImageUrl(cardId);
  }

  // ============================================
  // Browser preferences (not card or revision state)
  // ============================================

  async getSetting<T>(key: string): Promise<T | null> {
    return this.preferences.getSetting<T>(key);
  }

  async saveSetting<T>(key: string, value: T): Promise<void> {
    return this.preferences.saveSetting(key, value);
  }
}
