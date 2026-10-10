#!/usr/bin/env node
// Fetch the correct prebuilt tessera-cli release binary for this platform
// into resources/cli/ so electron-builder can bundle it via extraResources.
// Used both by CI (per matrix leg) and local dev/packaging.
//
// Pinned to a specific tessera-cli release (not "latest") so a desktop
// build is reproducible and never silently changes behaviour underneath
// the pinned tessera-apps release. Bump TESSERA_CLI_VERSION deliberately.

import fs from 'fs'
import path from 'path'
import https from 'https'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TESSERA_CLI_VERSION = process.env.TESSERA_CLI_VERSION || 'v1.5.0'

// Build-time-only override (Decision 6 / Task 6): when set, bundle the named
// local tessera-cli binary instead of downloading a pinned release. It exists
// so the pinned v1.5.0 (which lacks `account`) can be swapped for a locally
// built HEAD during development/testing of the balance panel. This is a
// build-time scaffolding hook, NOT a runtime switch: it is never set in the
// CI defaults (release builds always take the pinned download above), and the
// binary it copies is the ordinary resource that fetch:cli already publishes.
const TESSERA_CLI_PATH = process.env.TESSERA_CLI_PATH || ''

const ASSET_BY_PLATARCH = {
  'darwin-x64': 'tessera-darwin-amd64',
  'darwin-arm64': 'tessera-darwin-arm64',
  'linux-x64': 'tessera-linux-amd64',
  'win32-x64': 'tessera-windows-amd64.exe',
}

function key() {
  const plat = process.env.TESSERA_TARGET_PLATFORM || process.platform
  const arch = process.env.TESSERA_TARGET_ARCH || process.arch
  return `${plat}-${arch}`
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'tessera-apps-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location, dest).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`))
        return
      }
      const out = fs.createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => out.close(resolve))
    })
    req.on('error', reject)
  })
}

async function main() {
  const outDir = path.join(__dirname, '..', 'resources', 'cli')
  fs.mkdirSync(outDir, { recursive: true })

  // Build-time override: copy a locally built binary instead of downloading.
  // Taken before the platform/asset check so a local build for the host is
  // enough (no release asset needed). Never reached in CI defaults.
  if (TESSERA_CLI_PATH) {
    if (!fs.existsSync(TESSERA_CLI_PATH)) {
      throw new Error(`TESSERA_CLI_PATH set but not found: ${TESSERA_CLI_PATH}`)
    }
    const isWin = process.platform === 'win32'
    const outFile = path.join(outDir, isWin ? 'tessera-cli.exe' : 'tessera-cli')
    fs.copyFileSync(TESSERA_CLI_PATH, outFile)
    if (!isWin) fs.chmodSync(outFile, 0o755)
    console.log(`[fetch-cli] TESSERA_CLI_PATH override: ${TESSERA_CLI_PATH} -> ${outFile} (${fs.statSync(outFile).size} bytes)`)
    return
  }

  const k = key()
  const asset = ASSET_BY_PLATARCH[k]
  if (!asset) {
    console.error(`[fetch-cli] no tessera-cli asset mapping for ${k} — skipping bundling`)
    return
  }
  const isWin = asset.endsWith('.exe')
  const outFile = path.join(outDir, isWin ? 'tessera-cli.exe' : 'tessera-cli')

  const url = `https://github.com/TesseraStorage/tessera-cli/releases/download/${TESSERA_CLI_VERSION}/${asset}`
  console.log(`[fetch-cli] ${url} -> ${outFile}`)
  await download(url, outFile)
  if (!isWin) fs.chmodSync(outFile, 0o755)
  const size = fs.statSync(outFile).size
  if (size < 1_000_000) throw new Error(`[fetch-cli] downloaded file suspiciously small (${size} bytes) — bad asset?`)
  console.log(`[fetch-cli] ok, ${size} bytes`)
}

main().catch((e) => { console.error('[fetch-cli] FAILED:', e.message); process.exit(1) })
