// Desktop updater (v0.8.0): version compare, asset choice, SHA256SUMS
// parsing and the verify-before-install download. No Electron runtime.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as u from '../electron/updater.mjs'

const ASSETS = [
  'Tessera-0.8.0-arm64.dmg', 'Tessera-0.8.0-x64.dmg', 'Tessera-0.8.0-x64.exe',
  'Tessera-0.8.0-x86_64.AppImage', 'Tessera-0.8.0-amd64.deb', 'Tessera-0.8.0-x86_64.rpm', 'SHA256SUMS',
].map((name) => ({ name, browser_download_url: `https://dl.example/${name}`, size: 3 }))

test('isNewerVersion compares numerically and ignores dev suffixes', () => {
  assert.equal(u.isNewerVersion('v0.8.0', '0.7.0'), true)
  assert.equal(u.isNewerVersion('v0.7.0', '0.7.0'), false)
  assert.equal(u.isNewerVersion('v0.10.0', '0.9.9'), true)
  assert.equal(u.isNewerVersion('v0.8.0', '0.0.0-0.abc1234'), true)
  assert.equal(u.isNewerVersion('', '0.7.0'), false)
})

test('pickAsset chooses the installer for each platform, arch and Linux format', () => {
  assert.equal(u.pickAsset(ASSETS, 'darwin', 'arm64').name, 'Tessera-0.8.0-arm64.dmg')
  assert.equal(u.pickAsset(ASSETS, 'darwin', 'x64').name, 'Tessera-0.8.0-x64.dmg')
  assert.equal(u.pickAsset(ASSETS, 'win32', 'x64').name, 'Tessera-0.8.0-x64.exe')
  assert.equal(u.pickAsset(ASSETS, 'linux', 'x64', 'appimage').name, 'Tessera-0.8.0-x86_64.AppImage')
  assert.equal(u.pickAsset(ASSETS, 'linux', 'x64', 'deb').name, 'Tessera-0.8.0-amd64.deb')
  assert.equal(u.pickAsset(ASSETS, 'linux', 'x64', 'rpm').name, 'Tessera-0.8.0-x86_64.rpm')
  assert.equal(u.pickAsset([], 'linux', 'x64'), null)
})

test('parseSha256Sums reads text and binary-mode lines', () => {
  const a = 'a'.repeat(64); const b = 'B'.repeat(64)
  assert.deepEqual(u.parseSha256Sums(`${a}  Tessera.dmg\n${b} *dir/Tessera.exe\njunk\n`), { 'Tessera.dmg': a, 'Tessera.exe': b.toLowerCase() })
})

function fakeFetch(files) {
  return async (url) => {
    const name = url.split('/').pop()
    if (url.includes('api.github.com')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.8.0', html_url: 'https://gh/rel', assets: ASSETS }) }
    }
    if (!(name in files)) return { ok: false, status: 404 }
    const body = Buffer.from(files[name])
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k === 'content-length' ? String(body.length) : null) },
      text: async () => body.toString(),
      body: { getReader() { let done = false; return { read: async () => (done ? { done: true } : (done = true, { done: false, value: new Uint8Array(body) })) } } },
    }
  }
}

test('checkForUpdate reports the asset and SHA256SUMS; a failed check is no update', async () => {
  const info = await u.checkForUpdate({ fetchFn: fakeFetch({}), current: '0.7.0', platform: 'win32', arch: 'x64' })
  assert.equal(info.available, true)
  assert.equal(info.latest, 'v0.8.0')
  assert.equal(info.asset.name, 'Tessera-0.8.0-x64.exe')
  assert.match(info.sumsUrl, /SHA256SUMS$/)
  const bad = await u.checkForUpdate({ fetchFn: async () => { throw new Error('offline') }, current: '0.7.0', platform: 'win32', arch: 'x64' })
  assert.equal(bad.available, false)
})

test('downloadAndVerify keeps a matching download and discards a mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-upd-'))
  const payload = 'installer-bytes'
  const good = crypto.createHash('sha256').update(payload).digest('hex')
  const info = await u.checkForUpdate({ fetchFn: fakeFetch({}), current: '0.7.0', platform: 'win32', arch: 'x64' })

  const ok = await u.downloadAndVerify(info, dir, { fetchFn: fakeFetch({ SHA256SUMS: `${good}  Tessera-0.8.0-x64.exe\n`, 'Tessera-0.8.0-x64.exe': payload }) })
  assert.equal(ok.ok, true)
  assert.equal(ok.sha256, good)
  assert.equal(fs.readFileSync(ok.file, 'utf8'), payload)

  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir)
  const bad = await u.downloadAndVerify(info, dir, { fetchFn: fakeFetch({ SHA256SUMS: `${'0'.repeat(64)}  Tessera-0.8.0-x64.exe\n`, 'Tessera-0.8.0-x64.exe': payload }) })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /Checksum mismatch/)
  assert.deepEqual(fs.readdirSync(dir), [])

  const nosums = await u.downloadAndVerify({ ...info, sumsUrl: '' }, dir, { fetchFn: fakeFetch({}) })
  assert.equal(nosums.ok, false)
  assert.match(nosums.error, /SHA256SUMS/)
  fs.rmSync(dir, { recursive: true, force: true })
})
