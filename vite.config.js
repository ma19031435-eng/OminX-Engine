/**
 * OminX Engine — dev/build configuration.
 *
 * The editor is a browser app, so the dev server has to be reachable from outside the machine it
 * runs on: it binds every interface and accepts any host header (preview environments proxy the app
 * under their own domain, and Vite rejects unknown hosts by default).
 *
 * The multiplayer client is relative-URL first: it connects back to whatever origin served the page
 * (`?server=wss://…` overrides it), which keeps the app working behind a reverse proxy.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    cors: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  // Game code touches `window`, `document` and WebGPU; keep the deps pre-bundled as ESM.
  optimizeDeps: {
    include: ['monaco-editor'],
  },
});
