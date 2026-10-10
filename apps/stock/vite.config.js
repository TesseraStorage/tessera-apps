import { defineConfig } from 'vite'
import { resolve } from 'path'

// STOCK FACE (2026-09-30, "tessera-web-stock-face"): https://tessera.storage/v2/tessera/stock/
//
// Same shared UI source as apps/web, compiled with the door flag = 'stock' and Foundation's
// UNMODIFIED @siafoundation/sia-storage@0.0.14 (npm; wasm md5 3efe5aae...) in place of the
// Tessera T-SDK fork vendored at packages/shared/vendor/sia-storage. The alias below is the
// ONLY thing that swaps the SDK: packages/shared/src/sdk.js imports
// '../vendor/sia-storage/dist/index.js', and every import of that path in this build resolves
// to the npm package instead. The fork's wasm is therefore not in this bundle at all.
const STOCK_SDK = resolve(__dirname, '../../node_modules/@siafoundation/sia-storage/dist/index.js')

export default defineConfig({
  root: '.',
  base: './',
  define: { __TESSERA_DOOR__: JSON.stringify('stock') },
  resolve: {
    alias: [
      { find: /^(\.\.\/)+vendor\/sia-storage\/dist\/index\.js$/, replacement: STOCK_SDK },
    ],
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html') } },
  },
})
