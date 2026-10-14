import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const consumer = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const entries = ['@character-unity/browser-storage', '@character-unity/assets', '@character-unity/cards'];
export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/assets/browser-seed/',
  resolve: { alias: entries.map((entry) => ({ find: entry, replacement: consumer.resolve(entry) })) },
  build: { outDir: fileURLToPath(new URL('../../runtime/native-browser-web/assets/browser-seed', import.meta.url)), emptyOutDir: false,
    rollupOptions: { input: fileURLToPath(new URL('./seed.html', import.meta.url)) } },
};
