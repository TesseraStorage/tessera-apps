// @tessera/shared — file operations
//
// Desktop: delegates to native NAPI SDK via IPC.
// Web: uses proxy relay endpoints (POST /__sia__/upload etc.)
//      because WebTransport can't reach siamux hosts from the browser.

import { PinnedObject } from './sdk.js'
import { proxyOrigin } from './utils.js'

// ── helpers ──────────────────────────────────────────────

function isDesktop() {
  return !!(window.tesseraDesktop && window.tesseraDesktop.isDesktop)
}

function relayUrl(path) {
  return proxyOrigin() + '/__sia__/' + path
}

function relayCreds() {
  const appId = localStorage.getItem('tessera.aid') || ''
  const appKey = localStorage.getItem('tessera.akey') || ''
  if (!appId || !appKey) return ''
  return 'appId=' + encodeURIComponent(appId) + '&appKey=' + encodeURIComponent(appKey)
}

async function relayFetch(method, path, body) {
  const creds = relayCreds()
  if (!creds) throw new Error('Not connected — no credentials saved')

  const url = relayUrl(path) + (path.includes('?') ? '&' : '?') + creds
  const opts = { method }
  if (body) opts.body = body

  const resp = await fetch(url, opts)
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status }))
    throw new Error(err.error || 'HTTP ' + resp.status)
  }
  return resp
}

async function relayConnect() {
  const appId = localStorage.getItem('tessera.aid') || ''
  const appKey = localStorage.getItem('tessera.akey') || ''
  if (!appId || !appKey) return false

  const resp = await fetch(relayUrl('connect'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, appKey }),
  })
  const result = await resp.json()
  return result.ok
}

// ── list ────────────────────────────────────────────────

export async function listFiles(sdk) {
  if (isDesktop()) {
    const result = await window.tesseraDesktop.siaListFiles()
    if (!result.ok) throw new Error(result.error)
    return result.files
  }

  // Web: try proxy relay first
  try {
    const resp = await relayFetch('GET', 'list')
    const result = await resp.json()
    if (result.ok) return result.files
  } catch (_) { /* fall back to WASM SDK below */ }

  // Web fallback: WASM SDK
  const byId = new Map()
  let cursor = null
  for (;;) {
    const events = await sdk.objectEvents(cursor || undefined, 100)
    if (!events || !events.length) break
    for (const ev of events) {
      if (ev.deleted) { byId.delete(ev.id); continue }
      let name = ev.id.slice(0, 12) + '\u2026'
      let size = 0
      const obj = ev.object
      if (obj) {
        size = obj.size()
        const meta = obj.metadata()
        if (meta && meta.length) {
          try { const m = JSON.parse(new TextDecoder().decode(meta)); if (m.name) name = m.name } catch (_) {}
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

export function computeTotals(files) {
  let total = 0
  for (const f of files) total += f.size
  return { count: files.length, totalBytes: total }
}

// ── upload ──────────────────────────────────────────────

export async function uploadFile(sdk, file, onProgress) {
  if (isDesktop()) {
    const start = Date.now()
    const tick = (s, p) => { if (onProgress) onProgress({ stage: s, percent: p, elapsed: Date.now() - start }) }
    tick('reading', 0)
    const filePath = await window.tesseraDesktop.openFileDialog()
    if (!filePath) throw new Error('No file selected')
    const fileBuffer = await window.tesseraDesktop.readFile(filePath)
    const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'upload'
    tick('uploading', 10)
    const ext = (fileName.split('.').pop() || '').toLowerCase()
    const mimeMap = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
      webp:'image/webp', svg:'image/svg+xml', pdf:'application/pdf', txt:'text/plain',
      md:'text/markdown', json:'application/json', js:'application/javascript',
      html:'text/html', css:'text/css', zip:'application/zip', mp4:'video/mp4',
      mp3:'audio/mpeg', wav:'audio/wav' }
    const mimeType = mimeMap[ext] || 'application/octet-stream'
    const result = await window.tesseraDesktop.siaUpload(fileName, fileBuffer, mimeType)
    if (!result.ok) throw new Error(result.error)
    tick('done', 100)
    return { id: result.id, size: result.size }
  }

  // Web: use proxy relay
  if (file) {
    const start = Date.now()
    const tick = (s, p) => { if (onProgress) onProgress({ stage: s, percent: p, elapsed: Date.now() - start }) }
    tick('uploading', 10)

    // Animate progress while the upload runs (the relay doesn't stream progress)
    let progress = 10
    const timer = setInterval(() => {
      if (progress < 85) { progress += 3; tick('uploading', progress) }
    }, 2000)

    try {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      const resp = await relayFetch('POST', 'upload?name=' + encodeURIComponent(file.name) +
        '&mime=' + encodeURIComponent(file.type || 'application/octet-stream'), bytes)
      const result = await resp.json()
      clearInterval(timer)
      if (!result.ok) throw new Error(result.error)
      tick('pinning', 95)
      tick('done', 100)
      return { id: result.id, size: result.size }
    } catch (e) {
      clearInterval(timer)
      if (e.message.includes('Not connected')) throw e
      throw e
    }
  }

  // WASM SDK fallback (no file = called from dropzone, or relay failed)
  const start = Date.now()
  const tick = (s, p) => { if (onProgress) onProgress({ stage: s, percent: p, elapsed: Date.now() - start }) }
  tick('preparing', 0)
  const meta = new TextEncoder().encode(JSON.stringify({
    name: file ? file.name : 'upload',
    mime: file ? (file.type || 'application/octet-stream') : 'application/octet-stream',
  }))
  let obj = new PinnedObject()
  obj.updateMetadata(meta)
  tick('uploading', 5)
  const stream = file ? file.stream() : new ReadableStream({ start(c) { c.enqueue(new Uint8Array(0)); c.close() } })
  const uploadPromise = sdk.upload(obj, stream, { dataShards: 10, parityShards: 20 })
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Upload timed out after 5 minutes')), 300000))
  obj = await Promise.race([uploadPromise, timeoutPromise])
  tick('pinning', 90)
  await sdk.pinObject(obj)
  tick('done', 100)
  return obj
}

// ── download ────────────────────────────────────────────

export async function getObject(sdk, objectId) {
  return sdk.object(objectId)
}

export async function downloadToDisk(sdk, objOrId, filename) {
  if (isDesktop()) {
    const objectId = typeof objOrId === 'string' ? objOrId : objOrId.id()
    const result = await window.tesseraDesktop.siaDownload(objectId)
    if (!result.ok) throw new Error(result.error)
    const savePath = await window.tesseraDesktop.saveFileDialog(filename)
    if (!savePath) return
    await window.tesseraDesktop.writeFile(savePath, result.data)
    return
  }

  const objectId = typeof objOrId === 'string' ? objOrId : objOrId.id()

  // Web: use proxy relay
  try {
    const resp = await relayFetch('GET', 'download/' + objectId.replace(/\//g, ''))
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || 'download'
    a.click()
    URL.revokeObjectURL(url)
    return
  } catch (e) {
    if (e.message.includes('Not connected')) throw e
  }

  // WASM SDK fallback
  const obj = typeof objOrId === 'string' ? await getObject(sdk, objOrId) : objOrId
  if (!obj) throw new Error('Object not found')
  const stream = sdk.download(obj)
  const blob = await new Response(stream).blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename || 'download'; a.click()
  URL.revokeObjectURL(url)
}

// ── delete ──────────────────────────────────────────────

export async function deleteFile(sdk, objectId) {
  if (isDesktop()) {
    const result = await window.tesseraDesktop.siaDelete(objectId)
    if (!result.ok) throw new Error(result.error)
    return
  }

  // Web: try proxy relay
  try {
    const resp = await relayFetch('DELETE', 'delete/' + objectId.replace(/\//g, ''))
    const result = await resp.json()
    if (result.ok) return
  } catch (e) {
    if (e.message.includes('Not connected')) throw e
  }

  // WASM SDK fallback
  await sdk.deleteObject(objectId)
}

// ── share ───────────────────────────────────────────────

export async function createShareURL(sdk, objOrId) {
  if (isDesktop()) {
    const objectId = typeof objOrId === 'string' ? objOrId : objOrId.id()
    const result = await window.tesseraDesktop.siaShare(objectId)
    if (!result.ok) throw new Error(result.error)
    return result.url
  }

  const objectId = typeof objOrId === 'string' ? objOrId : objOrId.id()

  // Web: use proxy relay
  try {
    const resp = await relayFetch('POST', 'share', JSON.stringify({ objectId }))
    const result = await resp.json()
    if (result.ok) return result.url
    throw new Error(result.error || 'Share failed')
  } catch (e) {
    if (e.message.includes('Not connected')) throw e
  }

  // WASM SDK fallback
  const obj = typeof objOrId === 'string' ? await getObject(sdk, objOrId) : objOrId
  if (!obj) throw new Error('Object not found')
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  return sdk.shareObject(obj, expires)
}

// ── account ─────────────────────────────────────────────

export async function getAccount(sdk) {
  if (isDesktop()) {
    const result = await window.tesseraDesktop.siaAccount()
    if (!result.ok) throw new Error(result.error)
    return { ready: result.ready }
  }
  return sdk.account()
}

export async function waitForReady(sdk, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const acct = await getAccount(sdk)
    if (acct.ready) return acct
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error('Account not ready after ' + (timeoutMs / 1000) + 's')
}

// ── relay init ──────────────────────────────────────────

/**
 * Connect the proxy relay to the indexer using saved credentials.
 * Called by ui.js after a successful connect.  Does nothing in desktop mode.
 */
export async function initRelay() {
  if (isDesktop()) return true
  try {
    const ok = await relayConnect()
    if (ok) console.log('[tessera] relay connected')
    return ok
  } catch (e) {
    console.warn('[tessera] relay unavailable:', e.message)
    return false
  }
}