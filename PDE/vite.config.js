import { defineConfig } from 'vite';

export default defineConfig({
  root: './renderer',
  base: './',
  build: {
    outDir: '../renderer-dist',
    emptyOutDir: true,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true, // console.* 제거
        drop_debugger: true // debugger도 같이 제거 (선택)
      }
    }
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
  }
});