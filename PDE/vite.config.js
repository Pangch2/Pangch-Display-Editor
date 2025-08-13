// vite.config.js

import { defineConfig } from 'vite';

export default defineConfig({
  root: './renderer',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  // 아래 플러그인을 추가합니다.
  plugins: [
    {
      name: 'html-reload',
      handleHotUpdate({ file, server }) {
        if (file.endsWith('.html')) {
          server.ws.send({
            type: 'full-reload',
            path: '*'
          });
        }
      },
    }
  ],
});