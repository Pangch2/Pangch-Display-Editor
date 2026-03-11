import { defineConfig } from 'vite';

export default defineConfig({
  root: './renderer',
  base: './',
  build: {
    outDir: '../renderer-dist',
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
  }
});