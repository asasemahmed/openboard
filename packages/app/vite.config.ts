import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Where the OpenBoard server runs during development. */
const serverUrl = process.env.OPENBOARD_URL ?? 'http://127.0.0.1:4747';

/**
 * The dev server injects an inline script (React Refresh) and inline <style>
 * tags (CSS with hot reload), which the policy in index.html forbids. Relax
 * exactly those two directives, and only while serving; builds are untouched.
 */
function devCsp(): Plugin {
  return {
    name: 'openboard-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
        .replace("style-src-elem 'self';", "style-src-elem 'self' 'unsafe-inline';");
    },
  };
}

export default defineConfig({
  plugins: [react(), devCsp()],
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
