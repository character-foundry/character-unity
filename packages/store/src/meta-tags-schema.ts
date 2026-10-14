/** Migration 17: workspace-owned rules only; no card or search projection changes. */
export const metaTagSchema = [
  `CREATE TABLE unity_meta_tag_catalogs (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES unity_workspaces(id),
    version INTEGER NOT NULL CHECK(version > 0 AND version <= 9007199254740991),
    groups_json TEXT NOT NULL CHECK(json_valid(groups_json) AND json_type(groups_json) = 'array')
  )`,
] as const;
