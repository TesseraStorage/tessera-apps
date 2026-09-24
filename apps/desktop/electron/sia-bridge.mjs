// Tessera Desktop — Sia bridge (runs in Electron main process)
//
// Uses @siafoundation/sia-storage (native NAPI addon) for
// upload/download.  The native SDK has raw TCP access and speaks
// the proper siamux protocol to reach Sia hosts.

import { initSia, Builder, AppKey, PinnedObject } from '@siafoundation/sia-storage'
import { Readable } from 'node:stream'

// ── Fetch patching ───────────────────────────────────────
// Route indexer requests through the local proxy on :3099 so
// that CORS doesn't block them (the native SDK uses fetch internally).

const _origFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = function (input, init) {
  let url = typeof input === 'string' ? input : (input?.url || input?.href || '')
  if (typeof url === 'string' && url.includes('index.tessera.storage')) {
    url = 'http://localhost:3099/__proxy__?url=' + encodeURIComponent(url)
    if (typeof input === 'string') input = url
    else if (input && typeof input === 'object') input = new Request(url, input)
  }
  return _origFetch(input, init)
}

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

  obj = await sdk.upload(obj, source, {
    dataShards: 10,
    parityShards: 20,
  })

  if (onProgress) onProgress({ stage: 'pinning', percent: 90 })

  await sdk.pinObject(obj)

  if (onProgress) onProgress({ stage: 'done', percent: 100 })

  return { id: obj.id(), size: Number(obj.size()) }
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
            if (m.name) name = m.name
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