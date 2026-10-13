import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import web from '../../apps/web/vite.config.js';

// Resolve public entry points from their real consumer. The production application
// never imports this fixture; the browser suite builds it beneath the existing
// /assets/ route, without adding any production route or API testing backdoor.
const consumer = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const entries = ['react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-dom', 'react',
  '@character-unity/architect/host'];
export default {
  plugins: web.plugins,
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/assets/isolation/',
  css: { postcss: fileURLToPath(new URL('../../apps/web', import.meta.url)) },
  resolve: { alias: entries.map((entry) => ({ find: entry, replacement: consumer.resolve(entry) })), dedupe: ['react', 'react-dom', 'zustand'] },
  build: { outDir: fileURLToPath(new URL('../../apps/web/dist/assets/isolation', import.meta.url)), emptyOutDir: false,
    rollupOptions: { input: fileURLToPath(new URL('./isolation.html', import.meta.url)) } },
};
