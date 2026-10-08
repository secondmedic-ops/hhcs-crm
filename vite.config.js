import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// npm run dev = http://localhost:3000. /api (including the live-updates WebSocket) and /webhooks go to the local Worker
// started by RUN-LOCAL-TEST.bat (wrangler dev on :8787). With no Worker running, the app opens the in-browser demo.
const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8787';
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  server: {
    port: 3000,
    proxy: { '/api': { target: BACKEND, ws: true, changeOrigin: true }, '/webhooks': { target: BACKEND, changeOrigin: true } },
  },
  preview: { port: 3000 },
});
