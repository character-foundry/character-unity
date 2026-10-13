import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.UNITY_API_ORIGIN ?? 'http://127.0.0.1:9312';
const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${src('')}/` },
    ],
    dedupe: ['react', 'react-dom', 'zustand'],
  },
  // Scan Architect's lazily loaded editor up front so dependencies are bundled once,
  // not re-optimized mid-session (which serves mismatched chunks).
  optimizeDeps: { entries: ['index.html', '../../packages/architect/src/**/*.{ts,tsx}', '!../../packages/architect/src/**/*.test.*'] },
  server: {
    host: process.env.UNITY_WEB_HOST ?? '127.0.0.1',
    port: Number(process.env.UNITY_WEB_PORT ?? 9430),
    strictPort: true,
    // The API sees itself as the origin; the browser never talks to it directly.
    proxy: { '/api': { target: api, changeOrigin: true, headers: { origin: api } } },
  },
});
