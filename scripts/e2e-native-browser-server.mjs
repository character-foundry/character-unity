import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Deliberately no API, cookies, server database or storage reset. Each Playwright
// browser context supplies its own disposable IndexedDB library.
const root = resolve(process.argv[2] ?? 'runtime/native-browser-web');
const port = Number(process.argv[3] ?? 19434);
if (!root.startsWith(resolve('runtime') + sep) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use an owned runtime build and a valid test port');
const server = createServer(async (req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (req.method !== 'GET' || path.startsWith('/api/')) { res.writeHead(404).end(); return; }
  const asset = /^\/assets\/[a-zA-Z0-9._/-]+\.(?:js|css|html|wasm|woff|woff2|ttf)$/.test(path) && !path.split('/').includes('..');
  const file = asset ? path.slice(1) : path.includes('.') ? null : 'index.html';
  if (!file) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(resolve(root, file));
    const extension = file.split('.').at(-1);
    const types = { js: 'text/javascript', css: 'text/css', wasm: 'application/wasm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf' };
    res.writeHead(200, { 'content-type': types[extension] ?? 'text/html', 'cache-control': 'no-store' }).end(bytes);
  } catch { res.writeHead(404).end(); }
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
