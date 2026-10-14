const ancestry = `WITH RECURSIVE ancestry(id) AS (
  SELECT p.id UNION SELECT q.parent_id FROM unity_content_publications q JOIN ancestry a ON a.id = q.id WHERE q.parent_id IS NOT NULL
) SELECT 1 FROM ancestry a JOIN unity_content_publications q ON q.id = a.id`;
/** Trusted SQL expressions only; never interpolate caller values. */
export function contentVisibleSql(actor: string) {
  return `NOT EXISTS (${ancestry} WHERE NOT (q.owner_id = coalesce(${actor},'') OR q.visibility = 'public'
    OR (q.visibility = 'members' AND ${actor} IS NOT NULL)))`;
}
export function contentForkableSql(actor: string) {
  return `NOT EXISTS (${ancestry} WHERE q.allow_fork = 0 AND q.owner_id <> ${actor})`;
}
