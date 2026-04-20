import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages: '/<repo-name>/'. Root-domain deploys: '/'. Override with VITE_BASE.
  base: process.env.VITE_BASE || '/',
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
    },
  },
});
