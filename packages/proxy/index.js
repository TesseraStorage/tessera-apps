#!/usr/bin/env node
// Tessera proxy — serves the web app, proxies indexer requests, and
// provides Sia upload/download relay endpoints backed by the native SDK.

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = parseInt(process.env.PORT || '3099', 10)
const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'web', 'dist')
const MIME = { '.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon' }
const CORS = { 'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS,PATCH','access-control-allow-headers':'*','access-control-expose-headers':'*' }

// ── native SDK (lazy-loaded) ────────────────────────────

// Pre-funded service account with existing host contracts.
// Used for all host operations (upload/download) because new user
// accounts don't have contracts formed yet.
const SERVICE_APP_ID = '1483449cb22e73c9936cc4153bf071c4008c0787faf078d35bf95f702b326f23'
const SERVICE_APP_KEY = '6be4f21d5a4da5ab422077cb8188885e947f10aced92cded35c5aa9afad9d42c'

let nativeSdk = null
let serviceSdk = null  // cached service account SDK for host ops

// Per-user SDK cache — each user gets their own SDK instance so that
// indexer operations (list, pin, delete, share) are scoped to that user.
// Keyed by appId hex string.
const userSdks = new Map()

async function getNativeSdk() {
  if (!nativeSdk) {
    nativeSdk = await import('@siafoundation/sia-storage')
    await nativeSdk.initSia()
    console.error('[proxy] native SDK loaded')
  }
  return nativeSdk
}

async function getServiceSdk() {
  if (serviceSdk) return serviceSdk

  const { AppKey, Builder } = await getNativeSdk()
  const appIdBytes = new Uint8Array(Buffer.from(SERVICE_APP_ID, 'hex'))
  const appKeyBytes = new Uint8Array(Buffer.from(SERVICE_APP_KEY, 'hex'))
  const key = new AppKey(appKeyBytes)

  const builder = new Builder('https://index.tessera.storage', {
    id: appIdBytes,
    name: 'Tessera Relay',
    description: 'Proxy relay for web uploads',
    serviceUrl: 'https://index.tessera.storage',
  })

  serviceSdk = await builder.connected(key)
  console.error('[proxy] service SDK connected')
  return serviceSdk
}

/**
 * Return a user-specific SDK instance, creating one if needed.
 * User SDKs handle indexer operations (list, pin, delete, share) scoped
 * to the user's own account.  The service SDK is used only for raw host
 * data operations (upload/download bytes) because it has pre-formed contracts.
 */
async function getUserSdk(appId, appKey) {
  // Normalize appId to lowercase hex for reliable cache lookups
  const idKey = appId.toLowerCase()
  const cached = userSdks.get(idKey)
  if (cached) return cached

  const { AppKey, Builder } = await getNativeSdk()
  const appIdBytes = new Uint8Array(Buffer.from(appId, 'hex'))
  const appKeyBytes = new Uint8Array(Buffer.from(appKey, 'hex'))
  const key = new AppKey(appKeyBytes)

  const builder = new Builder('https://index.tessera.storage', {
    id: appIdBytes,
    name: 'Tessera User',
    description: 'Tessera web user',
    serviceUrl: 'https://index.tessera.storage',
  })

  const sdk = await builder.connected(key)
  if (!sdk) throw new Error('User SDK connection returned null — key may not be registered with the indexer')
  userSdks.set(idKey, sdk)
  console.error('[proxy] user SDK connected (appId ' + idKey.substring(0, 12) + '…)')
  return sdk
}

// ── static serving ──────────────────────────────────────

function serveStatic(req, res) {
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html'
  if (!path.extname(p)) return false
  const fp = path.join(STATIC, p); if (!fp.startsWith(STATIC)) return false
  try {
    const b = fs.readFileSync(fp)
    res.writeHead(200, {
      'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      'content-length': b.length,
      'access-control-allow-origin': '*',
    })
    res.end(b)
    return true
  } catch (_) { return false }
}

// ── idx proxy (mirrors nginx's /v2/tessera/*/idx/ location) ─
//
// Unlike proxy() above (?url=... query param, used by fetchMode='proxy'),
// this strips a fixed '/idx/' prefix and forwards the rest straight to
// the real indexer, exactly like nginx's proxy_pass https://index.tessera.storage/.
function idxProxy(req, res) {
  const rest = req.url.slice('/idx/'.length).replace(/^\/+/, '')
  const u = new URL('https://index.tessera.storage/' + rest)
  const hdrs = {}
  for (const k of Object.keys(req.headers)) {
    if (k !== 'host' && k !== 'connection' && k !== 'origin' && k !== 'referer')
      hdrs[k] = req.headers[k]
  }
  hdrs.host = u.hostname

  const up = https.request({
    hostname: u.hostname, port: 443,
    path: u.pathname + u.search, method: req.method, headers: hdrs,
    timeout: 120000,
  })
  up.on('error', e => {
    if (!res.headersSent) { res.writeHead(502, { ...CORS, 'content-type': 'text/plain' }); res.end('idx-proxy:' + e.message) }
  })
  up.on('response', upRes => {
    res.writeHead(upRes.statusCode, { ...upRes.headers, ...CORS, 'cache-control': 'no-store' })
    upRes.pipe(res)
  })
  req.pipe(up)
}

// ── indexer proxy ───────────────────────────────────────

function proxy(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams
  const target = params.get('url')
  if (!target) { res.writeHead(400, { ...CORS, 'content-type': 'text/plain' }); res.end('missing ?url='); return }

  const u = new URL(target)
  const hdrs = {}
  for (const k of Object.keys(req.headers)) {
    if (k !== 'host' && k !== 'connection' && k !== 'origin' && k !== 'referer')
      hdrs[k] = req.headers[k]
  }
  hdrs.host = u.hostname

  const transport = u.protocol === 'https:' ? https : http
  const up = transport.request({
    hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search, method: req.method, headers: hdrs,
    rejectUnauthorized: false, timeout: 120000,
  })
  up.on('error', e => {
    if (!res.headersSent) { res.writeHead(502, { ...CORS, 'content-type': 'text/plain' }); res.end('proxy:' + e.message) }
  })
  up.on('response', upRes => {
    const h = {}
    for (const k of Object.keys(upRes.headers)) h[k] = upRes.headers[k]
    delete h['content-security-policy']
    res.writeHead(upRes.statusCode, { ...h, ...CORS })
    upRes.pipe(res)
  })
  req.pipe(up)
}

// ── Sia relay endpoints ─────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

function parseQuery(req) {
  return new URL(req.url, 'http://localhost').searchParams
}

function json(res, data, status = 200) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

// POST /__sia__/connect  { appId, appKey }  →  { ok: true } | { error }
async function handleConnect(req, res) {
  try {
    const body = JSON.parse((await readBody(req)).toString())
    if (!body.appId || !body.appKey) return json(res, { ok: false, error: 'Missing appId or appKey' }, 400)
    // SDK creation is deferred until first upload/download to avoid
    // triggering host fetches and false occupancy on El Grande.
    json(res, { ok: true })
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500)
  }
}

// POST /__sia__/upload  raw binary body + query: name, mime, appId, appKey  →  { ok, id, size }
async function handleUpload(req, res) {
  try {
    const q = parseQuery(req)
    const appId = q.get('appId')
    const appKey = q.get('appKey')
    const fileName = q.get('name') || 'upload'
    const mimeType = q.get('mime') || 'application/octet-stream'
    if (!appId || !appKey) return json(res, { ok: false, error: 'Missing appId or appKey' }, 400)

    const userSdk = await getUserSdk(appId, appKey)
    const serviceSdk = await getServiceSdk()
    const { PinnedObject } = await getNativeSdk()

    const fileData = await readBody(req)

    console.error('[proxy] uploading ' + fileName + ' (' + fileData.length + ' bytes) for ' + appId.substring(0, 12) + '…')

    const meta = new TextEncoder().encode(JSON.stringify({ name: fileName, mime: mimeType }))
    let obj = new PinnedObject()
    obj.updateMetadata(meta)

    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(fileData)
        controller.close()
      },
    })

    // Upload raw bytes through the service SDK (has pre-formed host contracts),
    // then pin the object through the USER's SDK so it appears in their file list.
    console.error('[proxy] calling serviceSdk.upload...')
    obj = await serviceSdk.upload(obj, source, { dataShards: 10, parityShards: 20 })
    console.error('[proxy] upload returned, id=' + obj.id() + ', pinning under user SDK...')
    await userSdk.pinObject(obj)
    console.error('[proxy] pin done')
    json(res, { ok: true, id: obj.id(), size: Number(obj.size()) })
  } catch (e) {
    console.error('[proxy] upload error:', e.message)
    json(res, { ok: false, error: e.message }, 500)
  }
}

// GET /__sia__/download/:id?appId=...&appKey=...  →  streams file
async function handleDownload(req, res) {
  try {
    const urlParts = req.url.split('?')[0].split('/')
    const objectId = urlParts[urlParts.length - 1]
    const q = parseQuery(req)
    const appId = q.get('appId')
    const appKey = q.get('appKey')
    if (!appId || !appKey) return json(res, { ok: false, error: 'Missing appId or appKey' }, 400)
    if (!objectId || objectId.length < 10) return json(res, { ok: false, error: 'Missing objectId' }, 400)

    const userSdk = await getUserSdk(appId, appKey)
    const serviceSdk = await getServiceSdk()
    const obj = await userSdk.object(objectId)
    if (!obj) return json(res, { ok: false, error: 'Object not found' }, 404)

    // Download raw bytes through the service SDK (has host contracts)
    const stream = serviceSdk.download(obj)
    const reader = stream.getReader()
    const chunks = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
    }
    const data = Buffer.concat(chunks)

    // Get filename from metadata
    let filename = 'download'
    try {
      const meta = obj.metadata()
      if (meta && meta.length) {
        const m = JSON.parse(new TextDecoder().decode(meta))
        if (m.name) filename = m.name
      }
    } catch (_) {}

    console.error('[proxy] download: ' + objectId + ' → ' + data.length + ' bytes')
    res.writeHead(200, {
      ...CORS,
      'content-type': 'application/octet-stream',
      'content-length': data.length,
      'content-disposition': 'attachment; filename="' + encodeURIComponent(filename) + '"',
    })
    res.end(data)
  } catch (e) {
    console.error('[proxy] download error:', e.message)
    json(res, { ok: false, error: e.message }, 500)
  }
}

// GET /__sia__/list?appId=...&appKey=...  →  { ok, files: [...] }
async function handleList(req, res) {
  try {
    const q = parseQuery(req)
    const appId = q.get('appId')
    const appKey = q.get('appKey')
    if (!appId || !appKey) return json(res, { ok: false, error: 'Missing appId or appKey' }, 400)

    const sdk = await getUserSdk(appId, appKey)
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

    const files = Array.from(byId.values()).sort(
      (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
    )
    json(res, { ok: true, files })
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500)
  }
}

// DELETE /__sia__/delete/:id?appId=...&appKey=...  →  { ok: true }
async function handleDelete(req, res) {
  try {
    const urlParts = req.url.split('?')[0].split('/')
    const objectId = urlParts[urlParts.length - 1]
    const q = parseQuery(req)
    const appId = q.get('appId')
    const appKey = q.get('appKey')
    if (!appId || !appKey) return json(res, { ok: false, error: 'Missing appId or appKey' }, 400)

    const sdk = await getUserSdk(appId, appKey)
    await sdk.deleteObject(objectId)
    json(res, { ok: true })
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500)
  }
}

// POST /__sia__/share  body: { objectId } + query: appId, appKey  →  { ok, url }
async function handleShare(req, res) {
  try {
    const q = parseQuery(req)
    const appId = q.get('appId')
    const appKey = q.get('appKey')
    if (!appId || !appKey) return json(res, { ok: false, error: 'Missing appId or appKey' }, 400)

    const body = JSON.parse((await readBody(req)).toString())
    const objectId = body.objectId
    if (!objectId) return json(res, { ok: false, error: 'Missing objectId' }, 400)

    const sdk = await getUserSdk(appId, appKey)
    const obj = await sdk.object(objectId)
    if (!obj) return json(res, { ok: false, error: 'Object not found' }, 404)

    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const url = sdk.shareObject(obj, expires)
    json(res, { ok: true, url })
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500)
  }
}

// ── router ──────────────────────────────────────────────

const ROUTES = [
  ['POST', '/__sia__/connect', handleConnect],
  ['POST', '/__sia__/upload', handleUpload],
  ['GET',  '/__sia__/download/', handleDownload],
  ['GET',  '/__sia__/list', handleList],
  ['DELETE', '/__sia__/delete/', handleDelete],
  ['POST', '/__sia__/share', handleShare],
]

function matchRoute(method, url) {
  for (const [m, prefix, handler] of ROUTES) {
    if (method === m && (url === prefix || url.startsWith(prefix))) {
      return handler
    }
  }
  return null
}

const srv = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }

  // Sia relay endpoints
  const handler = matchRoute(req.method, req.url)
  if (handler) return handler(req, res)

  // Download page shortcuts
  if (req.url === '/d' || req.url === '/d/') {
    res.writeHead(302, { location: '/d/download.html' + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '') })
    return res.end()
  }

  // Indexer proxy
  if (req.url.startsWith('/__proxy__')) return proxy(req, res)

  // 'idx' fetch-mode proxy (2026-09-29): mirrors nginx's production
  // /v2/tessera/*/idx/ location (proxy_pass to the real indexer, prefix
  // stripped) so local dev testing of Tessera Web's default fetch mode
  // doesn't need a running nginx. Same upstream, same no-store headers.
  if (req.url.startsWith('/idx/')) return idxProxy(req, res)

  // Static files
  if (serveStatic(req, res)) return

  res.writeHead(404); res.end('not found')
})

srv.listen(PORT, () => console.error('[tessera] http://localhost:' + PORT))