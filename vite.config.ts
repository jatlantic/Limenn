import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Extension pages (side panel, options, offscreen engine). background.js + content.js are built by scripts/build-content.mjs.
const firefox = process.env.LIMENN_TARGET === 'firefox';

export default defineConfig({
  base: './',
  build: {
    outDir: firefox ? 'dist-firefox' : 'dist',
    emptyOutDir: true,
    target: firefox ? 'firefox128' : 'chrome120',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'sidepanel.html'),
        options: resolve(import.meta.dirname, 'options.html'),
        engine: resolve(import.meta.dirname, 'engine.html'),
        workspace: resolve(import.meta.dirname, 'workspace.html'),
        welcome: resolve(import.meta.dirname, 'welcome.html'),
      },
    },
  },
  // Direct file access to the ONNX runtime wasm (not in the package's exports map).
  resolve: { alias: { 'ort-dist': resolve(import.meta.dirname, 'node_modules/onnxruntime-web/dist') } },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
