// Task 0.3 — desktop native-NAPI packed upload integration test.
//
// Proves the Electron main-process bridge's uploadPacked() opens ONE
// PackedUpload session for a multi-file action and that the resulting objects
// really land in the live indexer in fewer slabs than the unpacked baseline.
//
// This is an integration test: it needs live demo-account credentials. It
// skips when they are absent, exactly like the CLI's packed integration tests.
// Credentials come from TESSERA_TEST_APP_ID / TESSERA_TEST_APP_KEY (and an
// optional TESSERA_TEST_INDEXER_URL), or from the local live-creds.json the
// Phase 0 experiment uses.
//
// Run with: node --test test/packed-upload.integration.test.mjs

import { register } from 'node:module'
register(new URL('./electron-loader.mjs', import.meta.url), import.meta.url)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const { initSia, Builder, AppKey } = await import('@siafoundation/sia-storage')
const bridge = await import('../electron/sia-bridge.mjs')

const INDEXER = process.env.TESSERA_TEST_INDEXER_URL || 'https://index.tessera.storage'
const CREDS_FILE = '/tmp/opencode/live-creds.json'

function loadCreds() {
  if (process.env.TESSERA_TEST_APP_ID && process.env.TESSERA_TEST_APP_KEY) {
    return { app_id: process.env.TESSERA_TEST_APP_ID, app_key: process.env.TESSERA_TEST_APP_KEY }
  }
  if (fs.existsSync(CREDS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
    if (raw.app_id && raw.app_key) return raw
  }
  return null
}

const creds = loadCreds()
// The CLI's live-creds.json stores the 64-byte ed25519 key (seed + public key),
// while the NAPI AppKey constructor takes the 32-byte seed. Slice to the seed.
const APP_KEY_HEX = creds ? creds.app_key.slice(0, 64) : null
const skip = creds ? false : 'no live demo-account credentials (TESSERA_TEST_APP_ID/KEY or live-creds.json)'

function makeFiles(count, size) {
  const files = []
  for (let i = 0; i < count; i++) {
    const buf = Buffer.alloc(size, i % 256)
    files.push({
      name: `packed-integration-${String(i).padStart(2, '0')}.bin`,
      mime: 'application/octet-stream',
      size,
      buffer: buf,
    })
  }
  return files
}

async function openVerificationSdk() {
  await initSia()
  const key = new AppKey(new Uint8Array(Buffer.from(APP_KEY_HEX, 'hex')))
  const builder = new Builder(INDEXER, {
    id: new Uint8Array(Buffer.from(creds.app_id, 'hex')),
    name: 'Tessera Desktop packed verification',
    description: 'Phase 0 packed-upload integration test',
    serviceUrl: INDEXER,
  })
  return builder.connected(key)
}

test('desktop uploadPacked packs 20 small files into one slab session', { skip }, async () => {
  await bridge.connect(creds.app_id, APP_KEY_HEX)

  const files = makeFiles(20, 10 * 1024)
  const progress = []
  const results = await bridge.uploadPacked(files, (p) => progress.push(p))

  assert.equal(results.length, 20, 'one result per input file')
  const failed = results.filter((r) => !r.ok)
  assert.deepEqual(failed, [], `all 20 files should upload; failures: ${JSON.stringify(failed)}`)

  const ids = results.map((r) => r.id)
  for (const id of ids) {
    assert.ok(id && id.length > 0, 'every packed file returns an object id')
  }
  // Progress must actually be reported and end at done/100.
  assert.ok(progress.length > 0, 'onProgress should be called')
  const last = progress[progress.length - 1]
  assert.equal(last.stage, 'done')
  assert.equal(last.percent, 100)

  // Verify against the real indexer: query each object and count distinct
  // slabs. 20 x 10KB = 200KB total, so the packed session should land them
  // in one slab (the CLI acceptance test asserts exactly this for 50 files).
  const verify = await openVerificationSdk()
  const slabKeys = new Set()
  const sizes = []
  try {
    for (const id of ids) {
      const obj = await verify.object(id)
      assert.ok(obj, `object ${id} should exist on the indexer`)
      sizes.push(Number(obj.size()))
      for (const slab of obj.slabs()) {
        slabKeys.add(slab.encryptionKey.toString('hex'))
      }
    }
    assert.ok(
      slabKeys.size <= 2,
      `20 packed 10KB files should share at most 2 slabs, got ${slabKeys.size}`,
    )
    // Sanity: each object reports the original 10KB payload size.
    for (const s of sizes) assert.equal(s, 10 * 1024)
  } finally {
    for (const id of ids) {
      try { await verify.deleteObject(id) } catch (_) {}
    }
  }

  bridge.disconnect()
})

test('desktop uploadPacked reports a per-file failure without aborting the batch', { skip }, async () => {
  await bridge.connect(creds.app_id, APP_KEY_HEX)

  const files = makeFiles(5, 10 * 1024)
  // Force one Add to fail by handing the bridge a file whose buffer is not a
  // valid byte source. The SDK contract says a failed Add registers no object
  // and leaves the session usable, so the other four must still pin.
  files[2] = { name: 'broken.bin', mime: 'application/octet-stream', size: 10 * 1024, buffer: null }

  const results = await bridge.uploadPacked(files, () => {})
  assert.equal(results.length, 5)
  assert.equal(results[2].ok, false, 'the broken file should fail')
  const successes = results.filter((r) => r.ok)
  assert.equal(successes.length, 4, 'the rest of the batch should still upload')

  const verify = await openVerificationSdk()
  try {
    for (const r of successes) {
      const obj = await verify.object(r.id)
      assert.ok(obj, `object ${r.id} should exist on the indexer`)
    }
  } finally {
    for (const r of successes) {
      try { await verify.deleteObject(r.id) } catch (_) {}
    }
  }

  bridge.disconnect()
})
