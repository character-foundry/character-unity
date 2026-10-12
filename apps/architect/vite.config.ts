import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: { 'import.meta.env.VITE_UNITY_STORAGE': JSON.stringify(mode === 'browser' ? 'browser' : 'local'),
    'import.meta.env.VITE_UNITY_ARCHIVE_ORIGIN': JSON.stringify(loadEnv(mode, process.cwd(), 'VITE_UNITY_ARCHIVE_ORIGIN').VITE_UNITY_ARCHIVE_ORIGIN ?? '') },
  build: { target: 'es2022' },
  server: { host: '127.0.0.1', port: 9310, strictPort: true, proxy: { '/api': 'http://127.0.0.1:9312' } },
}));
