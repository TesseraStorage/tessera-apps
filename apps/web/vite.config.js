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
        download: resolve(__dirname, 'd/download.html'),
      },
    },
  },
  server: {
    port: 5173,
    // Proxy requests that go through the fetch interceptor to the standalone
    // proxy on port 3099, which handles CORS and forwards to index.dithr.dev.
    // The shared interceptor rewrites indexer URLs to use the standalone proxy,
    // so these rules are only needed if the interceptor is disabled.
    proxy: {
      '/__proxy__': { target: 'http://localhost:3099', changeOrigin: true },
    },
  },
})