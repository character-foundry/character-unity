import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.UNITY_API_ORIGIN ?? 'http://127.0.0.1:9312';
const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // CardsHub components were written for Next.js; these small adapters keep them unchanged.
      { find: 'next/link', replacement: src('shims/next-link.tsx') },
      { find: 'next/image', replacement: src('shims/next-image.tsx') },
      { find: 'next/navigation', replacement: src('shims/next-navigation.ts') },
      { find: /^@\//, replacement: `${src('')}/` },
    ],
  },
  server: {
    host: process.env.UNITY_WEB_HOST ?? '127.0.0.1',
    port: Number(process.env.UNITY_WEB_PORT ?? 9430),
    strictPort: true,
    // The API sees itself as the origin; the browser never talks to it directly.
    proxy: { '/api': { target: api, changeOrigin: true, headers: { origin: api } } },
  },
});
