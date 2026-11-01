import { defineConfig } from 'vite';

export default defineConfig({
  root: './renderer',
  base: './',
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../renderer-dist',
    emptyOutDir: true,
  },
  esbuild: {
    drop: ['console', 'debugger'],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
  }
});
