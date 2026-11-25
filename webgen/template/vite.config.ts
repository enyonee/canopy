import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `npm run dev` proxies /api to a running Canopy app (CANOPY_API, default 127.0.0.1:8901). The Host header is
// kept as the browser sent it, so the runtime's same-origin rule (Origin host = Host) holds through the proxy.
const api = process.env.CANOPY_API || 'http://127.0.0.1:8901';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: { proxy: { '/api': { target: api, changeOrigin: false } } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
});
