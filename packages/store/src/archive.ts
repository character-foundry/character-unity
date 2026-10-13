import type { Statement, StoreDriver } from './driver.js';
import type { ArchiveAsset, ArchiveForkSource, ArchivePin, ArchiveReference, ArchiveReferenceInput, Asset, ImportIdentity, ImportMatch } from './types.js';
import { StoreError } from './types.js';
import * as validate from './validation.js';

type ReferenceRow = Omit<ArchiveReference, 'pin' | 'summary' | 'identity' | 'favorite'> & {
  archiveId: string; archiveCardId: string; versionId: string; summaryJson: string;
  algorithm: string | null; hash: string | null; favorite: number;
};
const referenceColumns = `id,workspace_id AS workspaceId,archive_id AS archiveId,archive_card_id AS archiveCardId,
  archive_version_id AS versionId,summary_json AS summaryJson,file_hash AS fileHash,
  content_algorithm AS algorithm,content_hash AS hash,module_hash AS moduleHash,lineage_hash AS lineageHash,
  favorite,created_at AS createdAt`;
const assetColumns = `a.id,a.workspace_id AS workspaceId,a.content_hash AS hash,a.byte_length AS byteLength,
  a.media_type AS mediaType,a.storage_key AS storageKey,a.state`;
const pinParams = (pin: ArchivePin) => [pin.archiveId, pin.cardId, pin.versionId];
function reference(row: ReferenceRow): ArchiveReference {
  const { archiveId, archiveCardId, versionId, summaryJson, algorithm, hash, favorite, ...rest } = row;
  return { ...rest, pin: { archiveId, cardId: archiveCardId, versionId }, summary: JSON.parse(summaryJson),
    identity: algorithm && hash ? { algorithm, hash } : null, favorite: Boolean(favorite) };
}
export function archiveForkStatement(workspaceId: string, cardId: string, pin: ArchivePin, sourceProvider: string, referenceId?: string): Statement {
  return { sql: `INSERT INTO unity_archive_fork_sources(card_id,workspace_id,archive_id,archive_card_id,archive_version_id,reference_id,source_provider)
    VALUES (?,?,?,?,?,?,?)`, params: [cardId, workspaceId, ...pinParams(pin), referenceId ?? null, sourceProvider] };
}
export function importClaimStatements(workspaceId: string, cardId: string, revisionId: string,
  input: ImportIdentity & { fileHash: string; identity: NonNullable<ImportIdentity['identity']> }): Statement[] {
  return [['file', 'sha256', input.fileHash], ['content', input.identity.algorithm, input.identity.hash]].map(([kind, algorithm, hash]) => ({
    sql: 'INSERT INTO unity_import_claims(workspace_id,kind,algorithm,hash,module_hash,lineage_hash,card_id,revision_id) VALUES (?,?,?,?,?,?,?,?)',
    params: [workspaceId, kind!, algorithm!, hash!, kind === 'content' ? input.moduleHash ?? '' : '',
      kind === 'content' ? input.lineageHash ?? '' : '', cardId, revisionId],
  }));
}

/** Archive ownership stays external; these operations write only library metadata. */
export function createArchiveOperations(driver: StoreDriver, batch: (statements: readonly Statement[]) => Promise<readonly number[]>) {
  async function requireWorkspace(workspaceId: string) {
    const [row] = await driver.query({ sql: 'SELECT id FROM unity_workspaces WHERE id = ?', params: [workspaceId] });
    if (!row) throw new StoreError('NOT_FOUND', 'Workspace not found');
  }
  async function getArchiveReference(workspaceId: string, id: string): Promise<ArchiveReference> {
    const [row] = await driver.query<ReferenceRow>({ sql: `SELECT ${referenceColumns} FROM unity_archive_references WHERE workspace_id = ? AND id = ?`,
      params: [validate.text(workspaceId, 'workspaceId'), validate.text(id, 'referenceId')] });
    if (!row) throw new StoreError('NOT_FOUND', 'Archive reference not found in this workspace');
    return reference(row);
  }
  async function bySource(workspaceId: string, pin: ArchivePin) {
    const [row] = await driver.query<ReferenceRow>({ sql: `SELECT ${referenceColumns} FROM unity_archive_references
      WHERE workspace_id = ? AND archive_id = ? AND archive_card_id = ? AND archive_version_id = ?`, params: [workspaceId, ...pinParams(pin)] });
    return row ? reference(row) : null;
  }
  async function findImportMatch(workspaceId: string, value: ImportIdentity): Promise<ImportMatch | null> {
    validate.text(workspaceId, 'workspaceId');
    const input = validate.importIdentity(value);
    if (input.fileHash) {
      const [claimed] = await driver.query<{ cardId: string; revisionId: string }>({ sql: `SELECT i.card_id AS cardId,i.revision_id AS revisionId
        FROM unity_import_claims i JOIN unity_cards c ON c.id = i.card_id WHERE i.workspace_id = ? AND i.kind = 'file'
        AND i.algorithm = 'sha256' AND i.hash = ? AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id) LIMIT 1`,
        params: [workspaceId, input.fileHash] });
      if (claimed) return { kind: 'card', ...claimed, match: 'file' };
      const [card] = await driver.query<{ cardId: string; revisionId: string }>({ sql: `SELECT c.id AS cardId,c.head_revision_id AS revisionId
        FROM unity_card_sources s JOIN unity_assets a ON a.id = s.asset_id JOIN unity_cards c ON c.id = s.card_id
        WHERE s.workspace_id = ? AND a.content_hash = ? AND a.state = 'ready'
        AND c.forked_from_revision_id IS NULL AND NOT EXISTS (SELECT 1 FROM unity_archive_fork_sources af WHERE af.card_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id)
        ORDER BY c.created_at,c.id LIMIT 1`, params: [workspaceId, input.fileHash] });
      if (card) return { kind: 'card', ...card, match: 'file' };
      const [ref] = await driver.query<{ referenceId: string }>({ sql: `SELECT id AS referenceId FROM unity_archive_references
        WHERE workspace_id = ? AND file_hash = ? ORDER BY created_at,id LIMIT 1`, params: [workspaceId, input.fileHash] });
      if (ref) return { kind: 'reference', ...ref, match: 'file' };
    }
    if (input.identity) {
      // Imports may receive their first lineage marker after computing the accepted-input
      // identity. This receipt is valid only while that exact first revision is the head.
      const [claimed] = await driver.query<{ cardId: string; revisionId: string }>({ sql: `SELECT i.card_id AS cardId,i.revision_id AS revisionId
        FROM unity_import_claims i JOIN unity_cards c ON c.id = i.card_id AND c.head_revision_id = i.revision_id
        WHERE i.workspace_id = ? AND i.kind = 'content' AND i.algorithm = ? AND i.hash = ? AND i.module_hash = ? AND i.lineage_hash = ?
        AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id) LIMIT 1`,
        params: [workspaceId, input.identity.algorithm, input.identity.hash, input.moduleHash ?? '', input.lineageHash ?? ''] });
      if (claimed) return { kind: 'card', ...claimed, match: 'content' };
      const [card] = await driver.query<{ cardId: string; revisionId: string }>({ sql: `SELECT c.id AS cardId,r.id AS revisionId
        FROM unity_cards c JOIN unity_revisions r ON r.id = c.head_revision_id JOIN unity_revision_seals z ON z.revision_id = r.id
        WHERE c.workspace_id = ? AND r.content_algorithm = ? AND r.content_hash = ?
        AND coalesce((SELECT a.content_hash FROM unity_revision_assets ra JOIN unity_assets a ON a.id = ra.asset_id
          WHERE ra.revision_id = r.id AND ra.path = 'module.risum'),'') = ?
        AND coalesce(json_extract(r.document_json,'$.data.extensions.foundry.lineage.revisionHash'),'') = ?
        AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id)
        ORDER BY c.created_at,c.id LIMIT 1`, params: [workspaceId, input.identity.algorithm, input.identity.hash,
          input.moduleHash ?? '', input.lineageHash ?? ''] });
      if (card) return { kind: 'card', ...card, match: 'content' };
      const [ref] = await driver.query<{ referenceId: string }>({ sql: `SELECT id AS referenceId FROM unity_archive_references
        WHERE workspace_id = ? AND content_algorithm = ? AND content_hash = ?
        AND coalesce(module_hash,'') = ? AND coalesce(lineage_hash,'') = ? ORDER BY created_at,id LIMIT 1`,
        params: [workspaceId, input.identity.algorithm, input.identity.hash, input.moduleHash ?? '', input.lineageHash ?? ''] });
      if (ref) return { kind: 'reference', ...ref, match: 'content' };
    }
    return null;
  }
  async function getArchiveAsset(workspaceId: string, assetId: string): Promise<ArchiveAsset | null> {
    const [row] = await driver.query<{ archiveId: string; cardId: string; versionId: string; path: string }>({
      sql: `SELECT archive_id AS archiveId,archive_card_id AS cardId,archive_version_id AS versionId,path FROM unity_archive_assets
        WHERE workspace_id = ? AND asset_id = ?`, params: [validate.text(workspaceId, 'workspaceId'), validate.text(assetId, 'assetId')] });
    if (!row) return null;
    const { path, ...pin } = row;
    return { workspaceId, assetId, pin, path };
  }
  return {
    getArchiveReference, getArchiveAsset, findImportMatch,
    async findArchiveReference(workspaceId: string, pin: ArchivePin): Promise<ArchiveReference | null> {
      return bySource(validate.text(workspaceId, 'workspaceId'), validate.archivePin(pin));
    },
    async archiveMemberships(workspaceId: string, archiveId: string, versions: readonly { cardId: string; versionId: string }[]): Promise<Record<string, ArchiveReference>> {
      validate.text(workspaceId, 'workspaceId'); validate.text(archiveId, 'archiveId');
      if (versions.length > 200) validate.invalid('At most 200 Archive versions per lookup');
      const pins = versions.map((pin) => validate.archivePin({ archiveId, ...pin })), result: Record<string, ArchiveReference> = Object.create(null);
      for (let offset = 0; offset < pins.length; offset += 25) {
        const page = pins.slice(offset, offset + 25);
        const rows = await driver.query<ReferenceRow>({ sql: `SELECT ${referenceColumns} FROM unity_archive_references
          WHERE workspace_id = ? AND archive_id = ? AND (${page.map(() => '(archive_card_id = ? AND archive_version_id = ?)').join(' OR ')})`,
          params: [workspaceId, archiveId, ...page.flatMap((pin) => [pin.cardId, pin.versionId])] });
        for (const row of rows) result[row.archiveCardId] = reference(row);
      }
      return result;
    },
    async addArchiveReference(input: ArchiveReferenceInput): Promise<ArchiveReference> {
      const workspaceId = validate.text(input.workspaceId, 'workspaceId'), pin = validate.archivePin(input.pin);
      const summaryJson = JSON.stringify(validate.archiveSummary(input.summary)), fileHash = input.fileHash === undefined ? null : validate.hash(input.fileHash);
      const identity = input.identity ? validate.contentIdentity(input.identity) : null;
      const moduleHash = input.moduleHash == null ? null : validate.hash(input.moduleHash), lineageHash = input.lineageHash == null ? null : validate.hash(input.lineageHash);
      if (input.favorite !== undefined && typeof input.favorite !== 'boolean') validate.invalid('Expected favorite boolean');
      const favorite = Number(input.favorite ?? false);
      await requireWorkspace(workspaceId);
      await batch([{ sql: `INSERT INTO unity_archive_references(id,workspace_id,archive_id,archive_card_id,archive_version_id,
        summary_json,file_hash,content_algorithm,content_hash,module_hash,lineage_hash,favorite,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,archive_id,archive_card_id,archive_version_id) DO UPDATE SET favorite = max(favorite,excluded.favorite)`,
      params: [crypto.randomUUID(), workspaceId, ...pinParams(pin), summaryJson, fileHash, identity?.algorithm ?? null, identity?.hash ?? null,
        moduleHash, lineageHash, favorite, new Date().toISOString()] }]);
      return (await bySource(workspaceId, pin))!;
    },
    async listArchiveReferences(workspaceId: string, options: { limit?: number; afterId?: string } = {}): Promise<ArchiveReference[]> {
      const rows = await driver.query<ReferenceRow>({ sql: `SELECT ${referenceColumns} FROM unity_archive_references
        WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?`, params: [validate.text(workspaceId, 'workspaceId'),
          options.afterId === undefined ? '' : validate.text(options.afterId, 'afterId'), validate.limit(options.limit)] });
      return rows.map(reference);
    },
    async setArchiveReferenceFavorite(workspaceId: string, id: string, favorite: boolean): Promise<void> {
      if (typeof favorite !== 'boolean') validate.invalid('Expected favorite boolean');
      await getArchiveReference(workspaceId, id);
      await batch([{ sql: 'UPDATE unity_archive_references SET favorite = ? WHERE workspace_id = ? AND id = ?', params: [Number(favorite), workspaceId, id] }]);
    },
    async removeArchiveReference(workspaceId: string, id: string): Promise<void> {
      await getArchiveReference(workspaceId, id);
      await batch([{ sql: 'DELETE FROM unity_archive_references WHERE workspace_id = ? AND id = ?', params: [workspaceId, id] }]);
    },
    async getArchiveForkSource(workspaceId: string, cardId: string): Promise<ArchiveForkSource | null> {
      const [row] = await driver.query<{ archiveId: string; archiveCardId: string; versionId: string; referenceId: string | null; sourceProvider: string }>({
        sql: `SELECT s.archive_id AS archiveId,s.archive_card_id AS archiveCardId,s.archive_version_id AS versionId,s.reference_id AS referenceId,s.source_provider AS sourceProvider
          FROM unity_archive_fork_sources s JOIN unity_cards c ON c.id = s.card_id WHERE s.workspace_id = ? AND s.card_id = ?
          AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id)`, params: [workspaceId, cardId] });
      if (!row) return null;
      return { workspaceId, cardId, pin: { archiveId: row.archiveId, cardId: row.archiveCardId, versionId: row.versionId }, referenceId: row.referenceId, sourceProvider: row.sourceProvider };
    },
    async registerArchiveAsset(input: { workspaceId: string; pin: ArchivePin; path: string; hash: string; byteLength: number; mediaType: string }): Promise<Asset> {
      const workspaceId = validate.text(input.workspaceId, 'workspaceId'), pin = validate.archivePin(input.pin), path = validate.assetPath(input.path);
      const id = crypto.randomUUID(), hash = validate.hash(input.hash), byteLength = validate.count(input.byteLength, 'byteLength'), mediaType = validate.text(input.mediaType, 'mediaType');
      async function existing() {
        const [asset] = await driver.query<Asset>({ sql: `SELECT ${assetColumns} FROM unity_archive_assets s JOIN unity_assets a ON a.id = s.asset_id
          WHERE s.workspace_id = ? AND s.archive_id = ? AND s.archive_card_id = ? AND s.archive_version_id = ? AND s.path = ?`,
          params: [workspaceId, ...pinParams(pin), path] });
        if (asset && (asset.hash !== hash || asset.byteLength !== byteLength || asset.mediaType !== mediaType)) {
          throw new StoreError('INTEGRITY', 'An immutable Archive asset changed its measured identity');
        }
        return asset;
      }
      const known = await existing(); if (known) return known;
      await requireWorkspace(workspaceId);
      const asset: Asset = { id, workspaceId, hash, byteLength, mediaType, storageKey: `archive-assets/${id}`, state: 'ready' };
      try {
        await batch([
          { sql: `INSERT INTO unity_assets(id,workspace_id,content_hash,byte_length,media_type,storage_key,state) VALUES (?,?,?,?,?,?,'ready')`,
            params: [id, workspaceId, hash, byteLength, mediaType, asset.storageKey] },
          { sql: `INSERT INTO unity_archive_assets(asset_id,workspace_id,archive_id,archive_card_id,archive_version_id,path) VALUES (?,?,?,?,?,?)`,
            params: [id, workspaceId, ...pinParams(pin), path] },
        ]);
      } catch (error) { const raced = await existing(); if (raced) return raced; throw error; }
      return asset;
    },
  };
}
