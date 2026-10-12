// Package the Electron app with the version stamped from the git tag.
//
// electron-builder reads the app version from package.json; we override it at
// package time with extraMetadata so the installer filenames
// (`${productName}-${version}-${arch}.${ext}`), the macOS "About" version and
// the Windows exe metadata all come from the tag — never a stale literal.
//
// Usage: node scripts/package.mjs [--mac|--linux|--win] [--arm64|--x64]
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { computeVersion } from '../../../scripts/version.mjs'

const version = computeVersion()
console.log(`[package] stamping version ${version}`)

const require = createRequire(import.meta.url)
const builder = require.resolve('electron-builder/out/cli/cli.js')
const args = [
  builder,
  `--config.extraMetadata.version=${version}`,
  ...process.argv.slice(2),
]
const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
