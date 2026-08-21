import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The UI talks to the backend on :8787 (see PORT in .env). Proxying keeps the
 * browser on one origin, so /api/session and the /api/events SSE stream are
 * same-origin and no CORS handling is needed on the express side.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      // SSE must not be buffered; ws:false keeps it a plain proxied stream.
      '/webhooks': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
