import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Where the OpenBoard server runs during development. */
const serverUrl = process.env.OPENBOARD_URL ?? 'http://127.0.0.1:4747';

export default defineConfig({
  plugins: [react()],
  // Assets are referenced from the site root so deep links such as /b/<id> load them correctly.
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: serverUrl, changeOrigin: false },
      '/sync': { target: serverUrl, ws: true, changeOrigin: false },
    },
  },
});
