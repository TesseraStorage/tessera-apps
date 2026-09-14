import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    target: 'esnext',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    port: 5174,
    // Same as apps/web: the shared fetch interceptor rewrites indexer
    // URLs to go through the standalone proxy on :3099 in dev. In
    // production this app's own /v2/tessera/web/idx/ nginx location
    // handles it instead -- see the packet's nginx section.
    proxy: {
      '/__proxy__': { target: 'http://localhost:3099', changeOrigin: true },
    },
  },
})
