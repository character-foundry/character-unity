import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Deliberately only a static file host: there is no API or server storage here.
const root = resolve('apps/architect/dist/browser-test');
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1:19311').pathname;
  const file = path === '/' ? 'index.html' : /^\/assets\/[a-zA-Z0-9._-]+\.(js|css)$/.test(path) ? path.slice(1) : null;
  if (!file || req.method !== 'GET') { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(resolve(root, file));
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' }).end(bytes);
  } catch { res.writeHead(404).end(); }
});
server.listen(19311, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
