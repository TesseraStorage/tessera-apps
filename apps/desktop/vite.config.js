import { defineConfig } from 'vite'
import path from 'path'

const sharedDir = path.resolve('../../packages/shared')

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    target: 'esnext',
    assetsInlineLimit: 0,
  },
  resolve: {
    alias: {
      // Map @tessera/shared to the shared package directory so that
      // both 'import {...} from "@tessera/shared"' and
      // 'import "@tessera/shared/style.css"' resolve correctly via the
      // package.json "exports" map.
      '@tessera/shared': sharedDir,
    },
  },
})