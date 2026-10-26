// Tessera Desktop — Sia bridge (runs in Electron main process)
//
// Uses @siafoundation/sia-storage (native NAPI addon) for
// upload/download.  The native SDK has raw TCP access and speaks
// the proper siamux protocol to reach Sia hosts.

import { initSia, Builder, AppKey, PinnedObject } from '@siafoundation/sia-storage'
import { Readable } from 'node:stream'
import * as cliBridge from './cli-bridge.mjs'

// ── Fetch patching ───────────────────────────────────────
// NOTE (fix, 2026-09-29): this used to rewrite every indexer request to
// http://localhost:3099/__proxy__?url=... under the theory that "CORS"
// would otherwise block them. That's wrong on two counts: (1) CORS is a
// browser-only restriction -- this file runs in the Electron MAIN process,
// which is plain Node, never subject to CORS; (2) :3099 is
// tessera-proxy.service, which only exists on the dev/prod server, is not
// bundled with the shipped app, and is intentionally left dead there too.
// On an end-user machine nothing listens on :3099, so every indexer call
// failed with a connection-refused surfaced through the native SDK as
// "client error: http error: error sending request". No rewrite needed --
// call index.tessera.storage directly (confirmed reachable, valid TLS,
// from a plain Node context).

// ── Module state ─────────────────────────────────────────

let sdk = null
let ready = false

async function ensureReady() {
  if (!ready) {
    await initSia()
    ready = true
  }
}

// ── Public API ───────────────────────────────────────────

export async function connect(appIdHex, appKeyHex) {
  await ensureReady()

  if (sdk) {
    try { sdk = null } catch (_) {}
  }

  const appIdBytes = new Uint8Array(Buffer.from(appIdHex, 'hex'))
  const appKeyBytes = new Uint8Array(Buffer.from(appKeyHex, 'hex'))
  const key = new AppKey(appKeyBytes)

  const builder = new Builder('https://index.tessera.storage', {
    id: appIdBytes,
    name: 'Tessera Desktop',
    description: 'Tessera desktop client',
    serviceUrl: 'https://index.tessera.storage',
  })

  sdk = await builder.connected(key)
  console.log('[sia-bridge] connected to indexer')

  // Seed the bundled tessera-cli's config with this same identity, so the
  // Synced Folders feature (which shells out to that binary) needs no
  // separate "tessera login" browser approval.
  try { cliBridge.writeConfig(appIdHex, appKeyHex) } catch (e) {
    console.error('[sia-bridge] could not seed tessera-cli config:', e.message)
  }

  return true
}

export function disconnect() {
  sdk = null
}

export async function getAccount() {
  if (!sdk) throw new Error('Not connected')
  const acct = await sdk.account()
  return {
    ready: acct.ready,
    remainingStorage: Number(acct.remainingStorage),
    pinnedData: Number(acct.pinnedData),
  }
}

// ── Upload ───────────────────────────────────────────────
// onProgress receives { stage: string, percent: number }

export async function uploadFile(fileName, fileBuffer, mimeType, onProgress) {
  if (!sdk) throw new Error('Not connected')

  if (onProgress) onProgress({ stage: 'preparing', percent: 0 })

  const meta = new TextEncoder().encode(JSON.stringify({
    name: fileName,
    mime: mimeType || 'application/octet-stream',
  }))

  let obj = new PinnedObject()
  obj.updateMetadata(meta)

  if (onProgress) onProgress({ stage: 'uploading', percent: 5 })

  // Use browser-style ReadableStream (global in Node 22)
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(fileBuffer)
      controller.close()
    },
  })

  const dataShards = 10
  const parityShards = 20
  const expectedShards = dataShards + parityShards
  let shardsLanded = 0

  obj = await sdk.upload(obj, source, {
    dataShards,
    parityShards,
    // REAL PROGRESS (2026-09-29, matches Tessera Web's WASM path in
    // files.js -- ShardProgress: hostKey, shardSize, shardIndex,
    // slabIndex, elapsedMs, per index.node.d.ts): without this, the
    // desktop app had exactly one blocking await from 5% to 90% that
    // could sit for minutes on a real file with the map showing
    // nothing -- this is the actual per-shard-landed signal the web
    // map is driven by, just not previously wired through IPC.
    onShardUploaded: (ev) => {
      shardsLanded += 1
      const percent = 5 + Math.min(85, Math.round((shardsLanded / expectedShards) * 85))
      if (onProgress) {
        onProgress({
          stage: 'uploading (' + shardsLanded + '/' + expectedShards + ')',
          percent,
          hostKey: ev && ev.hostKey,
          transferMs: ev && ev.elapsedMs,
        })
      }
    },
  })

  if (onProgress) onProgress({ stage: 'pinning', percent: 90 })

  await sdk.pinObject(obj)

  if (onProgress) onProgress({ stage: 'done', percent: 100 })

  return { id: obj.id(), size: Number(obj.size()) }
}

// ── Packed upload (Task 0.3) ─────────────────────────────
// A single `sdk.uploadPacked()` session shared by every file in one user
// action. This is the desktop counterpart of the web/WASM path in
// packages/shared/src/files.js: same underlying Rust SDK, different build
// target. Files are added in order; finalize() returns one object per added
// file in that same order (the SDK's documented contract), so per-file
// metadata can be attached afterwards without guessing which object is which.
//
// `files` is an array of { name, mime, buffer } where buffer is the file's
// bytes (Buffer/Uint8Array/ArrayBuffer) already read by the renderer. Zero
// byte files are partitioned out -- PackedUpload cannot encode an empty
// object, and add() would fail the whole slab, not just that file.
export async function uploadPacked(files, onProgress) {
  if (!sdk) throw new Error('Not connected')

  const list = Array.from(files || [])
  const results = new Array(list.length)
  if (list.length === 0) return results

  const tick = (stage, percent, extra) => {
    if (onProgress) onProgress({ stage, percent, ...(extra || {}) })
  }

  const dataShards = 10
  const parityShards = 20

  // Partition zero-byte files. They get a clean per-file error and never
  // enter the packed session.
  const zeroIdxs = []
  const packIdxs = []
  let totalBytes = 0
  for (let i = 0; i < list.length; i++) {
    const size = Number(list[i] && list[i].size != null ? list[i].size : (list[i].buffer ? list[i].buffer.byteLength : 0))
    if (size <= 0) zeroIdxs.push(i)
    else { packIdxs.push(i); totalBytes += size }
  }
  for (const i of zeroIdxs) results[i] = { ok: false, error: 'Empty files cannot be uploaded.' }
  if (packIdxs.length === 0) return results

  const expectedShards = Math.max(1, Math.ceil(totalBytes / (40 * 1024 * 1024))) * (dataShards + parityShards)
  let shardsLanded = 0

  tick('encoding\u2026', 0)

  let packed = null
  try {
    packed = sdk.uploadPacked({
      dataShards,
      parityShards,
      onShardUploaded: (ev) => {
        shardsLanded += 1
        const percent = 5 + Math.min(85, Math.round((shardsLanded / expectedShards) * 85))
        tick('uploading', percent, {
          hostKey: ev && ev.hostKey,
          transferMs: ev && ev.elapsedMs,
        })
      },
    })
  } catch (e) {
    for (const i of packIdxs) results[i] = { ok: false, error: 'Could not start packed upload: ' + ((e && e.message) || e) }
    return results
  }

  const addedIdxs = []
  for (const i of packIdxs) {
    const f = list[i]
    try {
      const raw = f && f.buffer
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
      await packed.add(source)
      addedIdxs.push(i)
    } catch (e) {
      // SDK contract: a failed add registers no object and leaves the session
      // usable. Report just this file and keep packing the rest.
      results[i] = { ok: false, error: 'Upload failed: ' + ((e && e.message) || e) }
    }
  }

  if (addedIdxs.length === 0) {
    try { packed.cancel() } catch (_) {}
    return results
  }

  tick('pinning', 90)

  let objects
  try {
    objects = await packed.finalize()
  } catch (e) {
    for (const i of addedIdxs) results[i] = { ok: false, error: 'Finalize failed: ' + ((e && e.message) || e) }
    return results
  }

  if (!Array.isArray(objects) || objects.length !== addedIdxs.length) {
    const got = Array.isArray(objects) ? objects.length : 'none'
    for (const i of addedIdxs) results[i] = { ok: false, error: 'Packed upload returned ' + got + ' objects for ' + addedIdxs.length + ' files' }
    return results
  }

  for (let k = 0; k < objects.length; k++) {
    const i = addedIdxs[k]
    const obj = objects[k]
    const f = list[i]
    try {
      const meta = Buffer.from(JSON.stringify({
        name: (f && f.name) || 'upload',
        mime: (f && f.mime) || 'application/octet-stream',
      }))
      obj.updateMetadata(meta)
      await sdk.pinObject(obj)
      results[i] = { ok: true, id: obj.id(), size: Number(obj.size()) }
    } catch (e) {
      results[i] = { ok: false, error: 'Pin failed: ' + ((e && e.message) || e) }
    }
  }

  tick('done', 100)
  return results
}

// ── Download ─────────────────────────────────────────────

export async function downloadFile(objectId) {
  if (!sdk) throw new Error('Not connected')

  const obj = await sdk.object(objectId)
  if (!obj) throw new Error('Object not found')

  const stream = sdk.download(obj)
  const reader = stream.getReader()
  const chunks = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

// ── List files ───────────────────────────────────────────

export async function listFiles() {
  if (!sdk) throw new Error('Not connected')

  const byId = new Map()
  let cursor = null

  for (;;) {
    const events = await sdk.objectEvents(cursor || undefined, 100)
    if (!events || !events.length) break

    for (const ev of events) {
      if (ev.deleted) {
        byId.delete(ev.id)
        continue
      }
      let name = ev.id.slice(0, 12) + '\u2026'
      let size = 0
      const obj = ev.object
      if (obj) {
        size = Number(obj.size())
        const metaBytes = obj.metadata()
        if (metaBytes && metaBytes.length) {
          try {
            const m = JSON.parse(new TextDecoder().decode(metaBytes))
            // PATH (2026-10-13, "files-view-nested-paths"): identical fix to
            // the web reader in packages/shared/src/files.js -- the sync
            // engine pins {name:<basename>, tessera:{path:<full path>}}; use
            // the descriptor's path so Files nests folders rather than
            // flattening every synced file onto its base name.
            if (m.tessera && typeof m.tessera.path === 'string' && m.tessera.path) name = m.tessera.path
            else if (m.name) name = m.name
          } catch (_) {}
        }
      }
      byId.set(ev.id, { id: ev.id, name, size, updatedAt: ev.updatedAt })
    }

    const last = events[events.length - 1]
    const next = { id: last.id, after: last.updatedAt }
    if (cursor && cursor.id === next.id) break
    cursor = next
  }

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  )
}

// ── Delete ───────────────────────────────────────────────

export async function deleteFile(objectId) {
  if (!sdk) throw new Error('Not connected')
  await sdk.deleteObject(objectId)
}

// ── Share ────────────────────────────────────────────────

export async function createShareURL(objectId) {
  if (!sdk) throw new Error('Not connected')
  const obj = await sdk.object(objectId)
  if (!obj) throw new Error('Object not found')
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  return sdk.shareObject(obj, expires)
}