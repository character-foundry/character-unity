/** Static browser-only host. IndexedDB remains on the user's existing origin;
 * this profile has no accounts, server storage, provider proxy or admin routes. */
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api' || path.startsWith('/api/')) return Response.json({ error: {
      code: 'BROWSER_STORAGE_ONLY', message: 'This profile stores cards in your browser and has no hosted API',
    } }, { status: 404, headers: { 'cache-control': 'no-store' } });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<BrowserEnv>;
