// @tessera/shared — file operations
//
// Desktop: delegates to native NAPI SDK via IPC.
// Web: uses proxy relay endpoints (POST /__sia__/upload etc.)
//      because WebTransport can't reach siamux hosts from the browser.
//
// PREFIX (2026-09-14, "tessera-web-v1"): relayCreds()/relayConnect() read
// the app-id/app-key localStorage pair through an injectable prefix so a
// second app (Tessera Web, 'tesseraweb') can call these same functions
// without ever reading Drop's tessera.aid/tessera.akey. Set once via
// setCredsPrefix() at app startup; defaults to 'tessera' (Drop, unchanged).

import { PinnedObject } from './sdk.js'
import { proxyOrigin } from './utils.js'
import { checkTunnelReachable } from './interceptor.js'

// FOLDERS (2026-09-15, "tessera-web-folders-v1"): "The SDK has no
// directories. A folder is a prefix on the object's existing metadata
// name." Forward slashes only; display name is the last segment; root
// is "". This constant is the marker object's own mime -- pinned so an
// otherwise-empty folder survives reload ("Empty folders persist").
// Never shown as a file row, never downloadable/shareable.
export const FOLDER_MARKER_MIME = 'application/x-tessera-folder'

// buildPath(dir, basename): the one place that joins a directory and a
// leaf name into a full metadata `name` string. dir === '' (root) means
// no prefix at all -- existing flat uploads (Drop, or any pre-folders
// Tessera Web object) are untouched by this function; it is only ever
// called with a non-empty dir when the caller is actually inside a
// folder.
export function buildPath(dir, basename) {
  return dir ? dir + '/' + basename : basename
}

// folderMarkerName(path): the exact metadata `name` a folder's marker
// object is pinned under -- always path + '/' (packet's own example:
// "Photos/"). `path` here is a full folder path with NO trailing
// slash (e.g. "Photos" or "Photos/Italy").
export function folderMarkerName(path) {
  return path + '/'
}

// validateFolderName(raw): "Reject empty, /, ., .. . Trim. Max 64
// characters." Applied to a SINGLE new segment (what "New folder"
// prompts for) -- a slash anywhere in the typed name is rejected
// outright, not just the exact strings "/" -- New folder always
// creates ONE segment inside the current directory; nesting happens by
// navigating in and creating another folder, not by typing a path.
export function validateFolderName(raw) {
  const name = (raw || '').trim()
  if (!name) return { ok: false, error: 'Please enter a folder name.' }
  if (name === '.' || name === '..') return { ok: false, error: 'That name is not allowed.' }
  if (name.includes('/')) return { ok: false, error: 'Folder names cannot contain "/".' }
  if (name.length > 64) return { ok: false, error: 'Folder names are limited to 64 characters.' }
  return { ok: true, name }
}

// computeFolderView(files, currentPath): splits the SDK's flat object
// list into the folders and files visible AT this one directory level
// -- "folder rows sit above file rows in the current place." `files`
// is listFiles()'s own flat array (every object, full-path `name`,
// unfiltered). `currentPath` is '' at root or a full path with no
// trailing slash (e.g. "Photos/Italy").
//
// A folder is "empty" (for display / delete purposes at THIS level)
// only in the recursive sense used by isNonEmptyFolder() below -- see
// that function's own comment for why markers don't count as "files".
export function computeFolderView(files, currentPath) {
  const prefix = currentPath ? currentPath + '/' : ''
  const folderNames = new Set()
  const fileRows = []
  for (const f of files) {
    if (prefix && !f.name.startsWith(prefix)) continue
    if (!prefix && f.name.includes('/') === false) {
      // Root, no prefix to strip -- a root-level file with no slash at
      // all in its name. Falls through to the fileRows push below.
    }
    const rel = prefix ? f.name.slice(prefix.length) : f.name
    if (rel === '') continue  // this directory's OWN marker -- never a row
    const slashIdx = rel.indexOf('/')
    if (slashIdx === -1) {
      // A direct child with no further path segment. This directory's
      // own marker (mime === FOLDER_MARKER_MIME) can only ever produce
      // rel === '' (handled above), so anything reaching here with no
      // slash is a genuine file -- but guard defensively anyway in
      // case of a malformed/legacy object.
      if (f.mime === FOLDER_MARKER_MIME) continue
      fileRows.push({ ...f, displayName: rel })
    } else {
      // Something inside a subfolder named rel.slice(0, slashIdx).
      // Its own marker (rel === subfolderName + '/', i.e. the slash is
      // the LAST character) only confirms existence; anything with
      // real content after that slash is just recorded as existing --
      // isNonEmptyFolder() (not this function) decides "has files" for
      // the Delete-refusal rule, since that check must also look
      // BELOW this one level (nested subfolders).
      folderNames.add(rel.slice(0, slashIdx))
    }
  }
  const folders = Array.from(folderNames).sort().map(name => ({
    name,
    path: buildPath(currentPath, name),
  }))
  return { folders, files: fileRows }
}

// isNonEmptyFolder(files, path): "Delete on a folder that has files:
// refuse... Do not recurse [into deleting]." This check itself DOES
// recurse (read-only) into every depth below `path` -- a file two
// levels down still means "this folder has files," matching the
// proof's own framing ("Delete Photos while it still has a file is
// refused" -- the file could be directly in Photos or in Photos/Italy).
// Folder MARKER objects (mime === FOLDER_MARKER_MIME) do not count as
// "files" here -- an entirely-empty nested subfolder (marker only, no
// real content anywhere under it) does not by itself make an ancestor
// folder "have files".
export function isNonEmptyFolder(files, path) {
  const prefix = path + '/'
  return files.some(f => f.name.startsWith(prefix) && f.mime !== FOLDER_MARKER_MIME)
}

// findFolderMarkerId(files, path): the marker object's own id, for the
// "empty folder: delete its marker only" path. Exact match only --
// path + '/' -- never a prefix match.
export function findFolderMarkerId(files, path) {
  const markerName = folderMarkerName(path)
  const hit = files.find(f => f.name === markerName)
  return hit ? hit.id : null
}

// ── helpers ──────────────────────────────────────────────

function isDesktop() {
  return !!(window.tesseraDesktop && window.tesseraDesktop.isDesktop)
}

let _credsPrefix = 'tessera'
export function setCredsPrefix(prefix) { _credsPrefix = prefix }

function relayUrl(path) {
  return proxyOrigin() + '/__sia__/' + path
}

function relayCreds() {
  const appId = localStorage.getItem(_credsPrefix + '.aid') || ''
  const appKey = localStorage.getItem(_credsPrefix + '.akey') || ''
  if (!appId || !appKey) return ''
  return 'appId=' + encodeURIComponent(appId) + '&appKey=' + encodeURIComponent(appKey)
}

async function relayFetch(method, path, body) {
  const creds = relayCreds()
  // FIX (2026-09-14, discovered while building Tessera Web): this used to
  // throw a message containing the substring "Not connected", which every
  // call site below re-throws instead of falling back to the WASM SDK
  // (see the catch blocks). That collided with the ALWAYS-EXPECTED case
  // of no plaintext appKey being saved at all -- which is now the NORMAL
  // state for any latched Drop account (tessera-drop-local-latch removed
  // plaintext tessera.akey once a vault exists) and for any account using
  // a non-'tessera' creds prefix (Tessera Web). Both cases must fall
  // through to WASM every time, not re-throw. Renamed so it no longer
  // matches the 'Not connected' guard; a genuine relay-reported
  // not-connected error (from the JSON response body, not this check)
  // still uses that exact phrase and is unaffected.
  if (!creds) throw new Error('No relay credentials saved for this prefix')

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
  const appId = localStorage.getItem(_credsPrefix + '.aid') || ''
  const appKey = localStorage.getItem(_credsPrefix + '.akey') || ''
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
      let mime = ''
      let size = 0
      const obj = ev.object
      if (obj) {
        size = obj.size()
        const meta = obj.metadata()
        if (meta && meta.length) {
          try {
            const m = JSON.parse(new TextDecoder().decode(meta))
            if (m.name) name = m.name
            // FOLDERS (2026-09-15, "tessera-web-folders-v1"): mime is
            // read through untouched here -- computeFolderView()/
            // isNonEmptyFolder() need it to recognize a folder marker
            // object (FOLDER_MARKER_MIME) and exclude it from the file
            // rows / "has files" check. Existing callers that only
            // ever used f.name/f.size are unaffected by this extra
            // field on the returned object.
            if (m.mime) mime = m.mime
          } catch (_) {}
        }
      }
      byId.set(ev.id, { id: ev.id, name, mime, size, updatedAt: ev.updatedAt })
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

// FOLDERS (2026-09-15, "tessera-web-folders-v1"): "Add while inside a
// folder writes currentPath + file.name into metadata, then the usual
// 10+20 + pin." New optional `metaName` parameter -- when provided,
// this exact string is what gets pinned into metadata.name (full path,
// e.g. "Photos/vacation.jpg"), while `file.name` (the browser File
// object's own leaf name, e.g. "vacation.jpg") is still what's sent to
// the relay's own `name=` query param and read for its MIME-sniffing
// extension -- the relay path is DEAD for Tessera Web regardless (no
// relay creds ever saved under the 'tesseraweb' prefix, confirmed by
// this file's own PREFIX comment), so `metaName` only actually takes
// effect on the WASM fallback below, which is the only path Web ever
// reaches. Every existing caller (Drop's ui.js, desktop) omits this
// argument entirely -- defaults to `file.name`, byte-identical to
// before this packet.
export async function uploadFile(sdk, file, onProgress, metaName) {
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

  // Web: try proxy relay first
  //
  // FIX (2026-09-14, "tessera-web-add-relay"): this used to unconditionally
  // re-throw on ANY relay failure -- including the always-expected "No relay
  // credentials saved for this prefix" case (Tessera Web's 'tesseraweb'
  // prefix never has relay creds; tessera-proxy stays dead by law). Every
  // sibling op (listFiles/downloadToDisk/deleteFile/createShareURL) already
  // falls through to the WASM SDK on relay miss -- upload was the one path
  // that didn't, so "Add" was the only op that could surface an internal
  // string like "No relay credentials saved for this prefix" to the
  // customer. Now it falls through silently, same as the others.
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
      // Fall through to the WASM SDK below on any relay miss -- including
      // the always-expected "No relay credentials saved for this prefix"
      // case, matching listFiles/downloadToDisk/deleteFile/createShareURL's
      // fallback behavior. Only a genuine relay-reported "Not connected"
      // (from the relay's own JSON error body, not the credential-missing
      // guard above -- see relayFetch's comment) rethrows, same guard those
      // three functions use.
      if (e.message.includes('Not connected')) throw e
      // Reset progress to the start of the WASM path so the bar doesn't
      // look like it's rewinding from ~85% back to 0/5%.
      tick('uploading', 5)
    }
  }

  // WASM SDK fallback (no file = called from dropzone, or relay failed)
  const start = Date.now()
  const tick = (s, p, hostKey) => { if (onProgress) onProgress({ stage: s, percent: p, elapsed: Date.now() - start, hostKey }) }
  tick('preparing', 0)

  // GATE (2026-09-14, "tessera-web-native-wt"): the tunnel preflight
  // below (added by "tessera-web-upload-hang") is only meaningful when
  // this browser's WebTransport is shimmed to the /__tunnel__ WebSocket
  // relay -- that's Drop's default path, unchanged. Tessera Web now uses
  // native, unshimmed WebTransport straight to hosts (no Tessera tunnel,
  // no tessera-proxy), so probing for a tunnel that Web deliberately does
  // not have would always fail and block every upload. window.___wtpoly___
  // is set by installWebTransportShim() itself -- true only when the shim
  // actually installed (Drop, or any future non-'idx' initSia() caller),
  // false when Tessera Web's initSia('idx') skipped it. Gate on that,
  // not on a hardcoded app check, so this keeps working correctly if
  // Drop's own shim path ever changes independently of this file.
  if (window.___wtpoly___) {
    const tunnelOk = await checkTunnelReachable()
    if (!tunnelOk) {
      throw new Error(
        'File storage is temporarily unavailable. Please try again in a few minutes.'
      )
    }
  }

  const meta = new TextEncoder().encode(JSON.stringify({
    name: metaName || (file ? file.name : 'upload'),
    mime: file ? (file.type || 'application/octet-stream') : 'application/octet-stream',
  }))
  let obj = new PinnedObject()
  obj.updateMetadata(meta)
  tick('uploading', 5)
  const stream = file ? file.stream() : new ReadableStream({ start(c) { c.enqueue(new Uint8Array(0)); c.close() } })

  // FIX (2026-09-14, "tessera-web-progress"): "Bar follows shards and pin.
  // No fake timer." The stock SDK's real progress signal is the
  // onShardUploaded option callback (confirmed present in the wasm
  // binary's own export table alongside dataShards/parityShards/
  // maxBufferedSlabs -- this is the SDK's own name, not invented here).
  // Denominator is dataShards + parityShards = 10 + 20 = 30 unless the
  // SDK's own event ever reports otherwise (defensive fallback below).
  // 5-90% is real shard-landed progress; 90-100% is the pin phase below.
  const dataShards = 10
  const parityShards = 20
  let expectedShards = dataShards + parityShards
  let shardsLanded = 0
  const onShardUploaded = (ev) => {
    // ev shape per the wasm binary's own field names: hostKey, shardSize,
    // shardIndex, slabIndex, elapsedMs. Use slabIndex-aware count only if
    // the SDK ever reports more than one slab; for a single-slab upload
    // (everything under ~40 MiB, per uploadPacked's own doc comment)
    // shardIndex 0..(expectedShards-1) covers the whole file.
    shardsLanded += 1
    if (ev && typeof ev.expectedShards === 'number' && ev.expectedShards > 0) {
      expectedShards = ev.expectedShards
    }
    const pct = 5 + Math.min(85, Math.round((shardsLanded / expectedShards) * 85))
    // FIX (2026-09-14, "tessera-web-map-progress"): forward the event's
    // own hostKey through onProgress so the caller (web-ui.js) can plot
    // it on the upload map -- this is the exact same live callback field
    // already used for the shard counter above, not a second signal or
    // an extra hosts() call.
    // COPY (2026-09-15, "tessera-web-look-v1"): "Progress: N/30 -- do not
    // say 'shards' next to the number. Quiet status: uploading (N/30)
    // then pinning -- no 'shards'." Was 'uploading (N/M shards)' --
    // matches the packet's own copy table exactly now.
    tick('uploading (' + shardsLanded + '/' + expectedShards + ')', pct, ev && ev.hostKey)
  }

  const uploadOptions = { dataShards, parityShards, onShardUploaded }
  // FIX (2026-09-14, "tessera-web-inflight"): "Faster shard writes."
  // maxInflight is the stock SDK's own documented upload option (see
  // node_modules/@siafoundation/sia-storage/README.md's own Uploading
  // example: `{ maxInflight: 10 }`) -- not invented here. Gated on
  // window.___wtpoly___ exactly like the tunnel-preflight gate above:
  // false only for Tessera Web's native-WebTransport path (initSia('idx')
  // skipped the shim), true for Drop's default shimmed/tunnel path. Per
  // packet law ("default maxInflight only when the Web prefix path
  // runs"), Drop's call site through this same shared function is
  // unchanged -- it still gets plain { dataShards, parityShards,
  // onShardUploaded } with no maxInflight key at all, identical to
  // before this task.
  if (!window.___wtpoly___) uploadOptions.maxInflight = 10

  const uploadPromise = sdk.upload(obj, stream, uploadOptions)
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Upload timed out after 5 minutes')), 300000))
  obj = await Promise.race([uploadPromise, timeoutPromise])
  tick('pinning', 90)
  await sdk.pinObject(obj)
  tick('done', 100)
  return obj
}

// ── folders ─────────────────────────────────────────────
//
// "Pin one marker object per folder... Smallest upload the SDK will
// pin (empty/tiny blob). Never shown as a file row. Never download /
// share / open as a file." Reuses uploadFile()'s own WASM SDK path
// (which already supports a zero-byte stream for the desktop dropzone
// case -- see `file ? file.stream() : new ReadableStream(...)` above)
// rather than duplicating the upload/pin call. Deliberately does NOT
// go through the relay-first branch above at all -- markers are tiny
// and infrequent, and Tessera Web never has relay creds anyway (this
// file's own PREFIX comment), so there is no real cost to always
// using the direct WASM path here, and it keeps this function simple
// (no progress ticks needed for a folder marker).
export async function createFolderMarker(sdk, path) {
  // GATE: same native-WebTransport tunnel preflight uploadFile() itself
  // runs, so a folder create fails the same clean way an Add would if
  // Tessera Web's own tunnel check ever applied (it doesn't today --
  // window.___wtpoly___ is false on Web's native path, so this is a
  // no-op in practice, kept only so this function's own behavior
  // matches uploadFile()'s exactly if that ever changes).
  if (window.___wtpoly___) {
    const tunnelOk = await checkTunnelReachable()
    if (!tunnelOk) {
      throw new Error('File storage is temporarily unavailable. Please try again in a few minutes.')
    }
  }
  const meta = new TextEncoder().encode(JSON.stringify({
    name: folderMarkerName(path),
    mime: FOLDER_MARKER_MIME,
  }))
  let obj = new PinnedObject()
  obj.updateMetadata(meta)
  // "Smallest upload the SDK will pin (empty/tiny blob)." -- a
  // zero-byte stream, same construction the WASM fallback in
  // uploadFile() already uses for the desktop no-file dropzone case.
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(0)); c.close() } })
  const uploadOptions = { dataShards: 10, parityShards: 20 }
  if (!window.___wtpoly___) uploadOptions.maxInflight = 10
  obj = await sdk.upload(obj, stream, uploadOptions)
  await sdk.pinObject(obj)
  return obj
}

// ── download ────────────────────────────────────────────

export async function getObject(sdk, objectId) {
  return sdk.object(objectId)
}

export async function downloadToDisk(sdk, objOrId, filename, onProgress) {
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
  // MAP INBOUND HOOK (2026-09-15, "tessera-web-look-v1"): "If download
  // does not yet call the map, hook onShardDownloaded the same way
  // write hooks onShardUploaded, with a direction flag. No second
  // hosts(). No new occupy." onShardDownloaded is the SDK's own
  // documented DownloadOptions field (confirmed in
  // node_modules/@siafoundation/sia-storage/wasm/sia_storage_wasm.d.ts
  // -- not invented here, same discovery shape as onShardUploaded's
  // own confirmation). This makes ZERO extra network calls of its own:
  // it observes shards the download was already fetching, exactly like
  // onShardUploaded observes shards the upload was already sending.
  // The relay-fetch path above (the WASM fallback's sibling, used when
  // this account has a __sia__ relay connection) has no equivalent
  // per-shard signal to hook -- it returns a single opaque Blob, so
  // downloads via that path have no inbound map trip; only the WASM
  // fallback path below can light up cyan arcs this packet.
  const downloadOptions = onProgress
    ? { onShardDownloaded: (ev) => onProgress({ hostKey: ev && ev.hostKey, direction: 'download' }) }
    : undefined
  const stream = sdk.download(obj, downloadOptions)
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

  /**
   * Wrap a raw SDK share URL into a URL that points to the Tessera
   * download page so recipients can actually download the file.
   *
   * In development the app runs on the Vite dev server (port 5173);
   * in production everything is served from the same origin as this page.
   */
  function wrapShareUrl(rawUrl) {
    const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '')
    return base + '/d/download.html?share=' + encodeURIComponent(rawUrl)
  }

  // Web: use proxy relay
  try {
    const resp = await relayFetch('POST', 'share', JSON.stringify({ objectId }))
    const result = await resp.json()
    if (result.ok) return wrapShareUrl(result.url)
    throw new Error(result.error || 'Share failed')
  } catch (e) {
    if (e.message.includes('Not connected')) throw e
  }

  // WASM SDK fallback
  const obj = typeof objOrId === 'string' ? await getObject(sdk, objOrId) : objOrId
  if (!obj) throw new Error('Object not found')
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const rawUrl = sdk.shareObject(obj, expires)
  return wrapShareUrl(rawUrl)
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