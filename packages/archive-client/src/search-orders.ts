/** Stable names from legacy Archive's Lance SORT_MAP. The copy advertises only
 * orders whose physical field has the required scalar type. */
export const indexSearchOrders = {
  new: { field: 'lastModified', ascending: false, label: 'Recently updated' },
  old: { field: 'lastModified', ascending: true, label: 'Least recently updated' },
  create_new: { field: 'createdAt', ascending: false, label: 'Newest created' },
  create_old: { field: 'createdAt', ascending: true, label: 'Oldest created' },
  tokens_desc: { field: 'tokenCount', ascending: false, label: 'Most tokens' },
  tokens_asc: { field: 'tokenCount', ascending: true, label: 'Fewest tokens' },
  most_stars_desc: { field: 'starCount', ascending: false, label: 'Most stars' },
  most_stars_asc: { field: 'starCount', ascending: true, label: 'Fewest stars' },
  most_favs_desc: { field: 'n_favorites', ascending: false, label: 'Most favorites' },
  most_favs_asc: { field: 'n_favorites', ascending: true, label: 'Fewest favorites' },
  most_msgs_desc: { field: 'nMessages', ascending: false, label: 'Most messages' },
  most_msgs_asc: { field: 'nMessages', ascending: true, label: 'Fewest messages' },
  most_chats_desc: { field: 'nChats', ascending: false, label: 'Most chats' },
  most_chats_asc: { field: 'nChats', ascending: true, label: 'Fewest chats' },
  overall_rating_desc: { field: 'scoreComposite', ascending: false, label: 'Highest overall rating' },
  overall_rating_asc: { field: 'scoreComposite', ascending: true, label: 'Lowest overall rating' },
  trending_desc: { field: 'scoreVelocity', ascending: false, label: 'Highest trending score' },
  trending_asc: { field: 'scoreVelocity', ascending: true, label: 'Lowest trending score' },
  engagement_desc: { field: 'engagementScore', ascending: false, label: 'Highest engagement' },
  engagement_asc: { field: 'engagementScore', ascending: true, label: 'Lowest engagement' },
  fresh_engagement_desc: { field: 'engagementVelocity', ascending: false, label: 'Highest recent engagement' },
  fresh_engagement_asc: { field: 'engagementVelocity', ascending: true, label: 'Lowest recent engagement' },
} as const;
export type IndexSearchSort = keyof typeof indexSearchOrders;
export type SearchSort = 'relevance' | 'title' | 'id' | IndexSearchSort;
export function isIndexSearchSort(value: unknown): value is IndexSearchSort { return typeof value === 'string' && Object.hasOwn(indexSearchOrders, value); }
export function isSearchSort(value: unknown): value is SearchSort { return value === 'relevance' || value === 'title' || value === 'id' || isIndexSearchSort(value); }
